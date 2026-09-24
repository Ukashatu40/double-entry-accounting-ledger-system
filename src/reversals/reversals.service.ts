// src/reversals/reversals.service.ts
import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
} from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import Decimal from 'decimal.js';
import { DatabaseService } from '@database/database.service';
import type { TransactionClient } from '@database/database.service';
import { LedgerService } from '@ledger/ledger.service';
import { BalanceService } from '@ledger/balance.service';
import type { LedgerEntry, Reversal } from '@prisma/client';
import type { FullReversalDto, PartialRefundDto } from './dto/reversal.dto';

export interface ReversalResult {
  reversalId: string;
  originalTransactionId: string;
  reversalTransactionId: string;
  amountReversed: string;
  feeReversed: string;
  journalId: string;
  postedAt: string;
}

@Injectable()
export class ReversalsService {
  private readonly logger = new Logger(ReversalsService.name);
  private platformOperatingCashAccountId: string | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly balance: BalanceService,
  ) {}

  /**
   * Derives the economically meaningful "original amount" of a
   * transaction from its raw ledger lines.
   *
   * IMPORTANT: this is NOT `SUM(debit lines)`. Since ADR-007
   * (docs/architecture/ADR-007-platform-operating-cash.md), correctly-
   * signed journal entries for fee/expense-splitting transactions
   * include a "1050 Platform Operating Cash" balancing leg whose
   * entryType and magnitude are a mechanical artifact of whatever
   * residual the OTHER lines happen to leave — summing debit lines
   * naively would pull that plug leg's amount into "original amount",
   * producing a number with no economic meaning (and one that silently
   * changes if the plug's magnitude changes, e.g. across handler
   * refactors). It also is NOT reliably "the DEBIT side" — which side
   * represents the customer's payment depends on transaction direction
   * (compare a deposit, where the wallet leg is DEBIT, against a
   * merchant payment, where it's CREDIT).
   *
   * The robust invariant instead: excluding the Platform Operating Cash
   * leg, the single largest-magnitude line in a well-formed origination
   * entry is always the customer-facing total (principal + fee/whatever
   * else they were charged) — every other "real" line is a component
   * split of that total across counterparties/P&L accounts. This holds
   * regardless of entryType direction or how many component lines exist.
   */
  private async deriveOriginalAmount(entries: LedgerEntry[]): Promise<Decimal> {
    const platformAccountId = await this.getPlatformOperatingCashAccountId();

    const economicLines = entries.filter((e) => e.accountId !== platformAccountId);
    const relevant = economicLines.length > 0 ? economicLines : entries;

    return relevant.reduce((max, e) => {
      const amount = new Decimal(e.amount.toString());
      return amount.gt(max) ? amount : max;
    }, new Decimal(0));
  }

  private async getPlatformOperatingCashAccountId(): Promise<string | null> {
    if (this.platformOperatingCashAccountId !== null) {
      return this.platformOperatingCashAccountId;
    }
    const account = await this.db.account.findUnique({ where: { code: '1050' } });
    this.platformOperatingCashAccountId = account?.id ?? null;
    return this.platformOperatingCashAccountId;
  }

  /**
   * Full reversal — creates an exact mirror of the original journal entry.
   *
   * No-mutation principle (spec A5.1):
   *   Every debit in the original becomes a credit in the reversal.
   *   Every credit in the original becomes a debit in the reversal.
   *   The original entries are NEVER modified.
   *
   * Idempotency: UNIQUE constraint on (originalTransactionId, idempotencyKey)
   * prevents duplicate reversals on network retries.
   */
  async reverseTransaction(
    dto: FullReversalDto,
    actor: string,
    idempotencyKey: string,
  ): Promise<ReversalResult> {
    // Check for duplicate reversal attempt
    const existingReversal = await this.db.reversal.findUnique({
      where: {
        originalTransactionId_idempotencyKey: {
          originalTransactionId: dto.originalTransactionId,
          idempotencyKey,
        },
      },
    });

    if (existingReversal) {
      this.logger.log(`Duplicate reversal request for ${dto.originalTransactionId} — replaying`);
      return this.buildReversalResult(existingReversal);
    }

    // Fetch the original ledger entries for this transaction
    const originalEntries = await this.db.ledgerEntry.findMany({
      where: { referenceId: dto.originalTransactionId, status: 'POSTED' },
      orderBy: { postedAt: 'asc' },
    });

    if (originalEntries.length === 0) {
      throw new NotFoundException(
        `No posted ledger entries found for transaction ${dto.originalTransactionId}`,
      );
    }

    // Compute total reversed amount for the reversal record — see
    // deriveOriginalAmount() for why this is NOT a naive sum of DEBIT lines.
    const totalAmount = await this.deriveOriginalAmount(originalEntries);

    const reversalTransactionId = uuidv7();

    // Build the mirror journal entry — flip every debit↔credit
    const mirrorLines = originalEntries.map((e: LedgerEntry) => ({
      accountId: e.accountId,
      entryType: e.entryType === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      amount: new Decimal(e.amount.toString()).toFixed(4),
      currency: e.currency,
      narrative: `Reversal of entry ${e.id}: ${dto.reason}`,
    }));

    // The "verify not already reversed" check and the "record the
    // reversal" insert must be one atomic, serialized unit — otherwise two
    // concurrent full-reversal requests for the same original transaction
    // can both pass the check before either commits (TOCTOU), producing two
    // mirror journals for one transaction. The advisory lock on
    // originalTransactionId serializes every reversal/refund attempt
    // against that transaction from the start; see ledger.service.ts's own
    // use of acquireAdvisoryLocks + withRetryTransaction for the precedent.
    const { journal, reversalRecord } = await this.db.withRetryTransaction(async (tx) => {
      await this.db.acquireAdvisoryLocks(tx, [dto.originalTransactionId]);

      await this.assertNotAlreadyReversed(dto.originalTransactionId, tx);

      const postedJournal = await this.ledger.postJournalEntry(
        {
          referenceType: 'REFUND_FULL',
          referenceId: reversalTransactionId,
          effectiveDate: new Date().toISOString(),
          lines: mirrorLines,
          metadata: {
            originalTransactionId: dto.originalTransactionId,
            reason: dto.reason,
            reversedBy: actor,
          },
        },
        actor,
        idempotencyKey,
        { checkBalanceOn: [], tx },
      );

      const createdReversal = await (tx as DatabaseService).reversal.create({
        data: {
          id: uuidv7(),
          originalTransactionId: dto.originalTransactionId,
          reversalTransactionId,
          amount: totalAmount.toFixed(4),
          currency: originalEntries[0]?.currency ?? 'INR',
          feePolicy: 'FULL',
          feeAmountReversed: '0.0000',
          reason: dto.reason,
          initiatedBy: actor,
          idempotencyKey,
        },
      });

      // Mark original transaction as REVERSED — folded into the same
      // transaction so it's atomic with the journal post + reversal insert.
      await (tx as DatabaseService).transaction.updateMany({
        where: { id: dto.originalTransactionId },
        data: { status: 'REVERSED' },
      });

      return { journal: postedJournal, reversalRecord: createdReversal };
    });

    // Transaction has committed — safe to update balance snapshots now
    // (see the `tx` option's contract on LedgerService.postJournalEntry).
    for (const accountId of new Set(journal.entries.map((e) => e.accountId))) {
      const lastEntry = journal.entries.find((e) => e.accountId === accountId);
      if (lastEntry) {
        await this.balance.updateSnapshot(accountId, lastEntry.id);
      }
    }

    this.logger.log(
      `Full reversal posted: original=${dto.originalTransactionId} ` +
        `reversal=${reversalTransactionId} amount=${totalAmount.toFixed(4)} by=${actor}`,
    );

    return {
      reversalId: reversalRecord.id,
      originalTransactionId: dto.originalTransactionId,
      reversalTransactionId,
      amountReversed: totalAmount.toFixed(4),
      feeReversed: '0.0000',
      journalId: journal.journalId,
      postedAt: journal.postedAt,
    };
  }

  /**
   * Partial refund with configurable fee policy (spec A5.2).
   *
   * Three policies:
   *   PROPORTIONAL — fee refund = (refundAmount / originalAmount) × originalFee
   *   FULL         — entire fee refunded (platform/merchant error)
   *   NONE         — fee retained (customer-initiated return)
   */
  async partialRefund(
    dto: PartialRefundDto,
    actor: string,
    idempotencyKey: string,
  ): Promise<ReversalResult> {
    // Duplicate check
    const existingReversal = await this.db.reversal.findUnique({
      where: {
        originalTransactionId_idempotencyKey: {
          originalTransactionId: dto.originalTransactionId,
          idempotencyKey,
        },
      },
    });

    if (existingReversal) {
      return this.buildReversalResult(existingReversal);
    }

    const originalEntries = await this.db.ledgerEntry.findMany({
      where: { referenceId: dto.originalTransactionId, status: 'POSTED' },
    });

    if (originalEntries.length === 0) {
      throw new NotFoundException(
        `No posted ledger entries for transaction ${dto.originalTransactionId}`,
      );
    }

    // Total original amount — see deriveOriginalAmount() for why this is
    // NOT a naive sum of DEBIT lines.
    const originalAmount = await this.deriveOriginalAmount(originalEntries);

    const refundAmount = new Decimal(dto.refundAmount);

    // Anti-fraud: refund must never exceed original
    if (refundAmount.gt(originalAmount)) {
      throw new UnprocessableEntityException(
        `Refund amount ${refundAmount.toFixed(4)} exceeds original ` +
          `transaction amount ${originalAmount.toFixed(4)} — (spec A5.2 guard)`,
      );
    }

    // Fee computation based on policy
    const originalFee = new Decimal(dto.originalFeeAmount ?? '0');
    let feeRefund = new Decimal(0);

    switch (dto.feePolicy) {
      case 'FULL':
        feeRefund = originalFee;
        break;

      case 'PROPORTIONAL':
        feeRefund = originalAmount.gt(0)
          ? refundAmount
              .dividedBy(originalAmount)
              .times(originalFee)
              .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          : new Decimal(0);
        break;

      case 'NONE':
        feeRefund = new Decimal(0);
        break;
    }

    const totalCredit = refundAmount.plus(feeRefund);
    const currency = originalEntries[0]?.currency ?? 'INR';
    const reversalTransactionId = uuidv7();

    const sortedByAmount = [...originalEntries].sort((a, b) =>
      new Decimal(b.amount.toString()).comparedTo(new Decimal(a.amount.toString())),
    );

    // Find the wallet (credit) account from original entries
    const walletEntry = sortedByAmount[0];
    const merchantEntry = sortedByAmount[1];

    if (!walletEntry || !merchantEntry) {
      throw new UnprocessableEntityException(
        'Cannot determine wallet/merchant accounts from original entries',
      );
    }

    const lines: {
      accountId: string;
      entryType: 'DEBIT' | 'CREDIT';
      amount: string;
      currency: string;
      narrative: string;
    }[] = [
      {
        accountId: merchantEntry.accountId,
        entryType: 'DEBIT',
        amount: refundAmount.toFixed(4),
        currency,
        narrative: `Partial refund (${dto.feePolicy}) — ref:${dto.originalTransactionId}: ${dto.reason}`,
      },
      {
        accountId: walletEntry.accountId,
        entryType: 'CREDIT',
        amount: totalCredit.toFixed(4),
        currency,
        narrative: `Partial refund credited — ${dto.reason}`,
      },
    ];

    // Add fee reversal line only if fee is being refunded
    if (feeRefund.gt(0) && originalEntries.length > 2) {
      const feeEntry = originalEntries.find(
        (e) => e.entryType === 'CREDIT' && e.accountId !== walletEntry.accountId,
      );
      if (feeEntry) {
        lines.splice(1, 0, {
          accountId: feeEntry.accountId,
          entryType: 'DEBIT',
          amount: feeRefund.toFixed(4),
          currency,
          narrative: `Fee reversal — ${dto.feePolicy} policy`,
        });
      }
    }

    // The "not fully reversed" + "cumulative refund limit" checks and the
    // "record the reversal" insert must be one atomic, serialized unit —
    // otherwise two concurrent partial refunds against the same original
    // transaction can both pass the checks before either commits (TOCTOU),
    // jointly over-refunding beyond the original amount. The advisory lock
    // on originalTransactionId serializes every reversal/refund attempt
    // against that transaction from the start — see reverseTransaction()'s
    // identical pattern and ledger.service.ts's own precedent.
    const { journal, reversalRecord } = await this.db.withRetryTransaction(async (tx) => {
      await this.db.acquireAdvisoryLocks(tx, [dto.originalTransactionId]);

      await this.assertNotFullyReversed(dto.originalTransactionId, tx);

      // Also check cumulative refunds don't exceed original
      await this.assertCumulativeRefundLimit(
        dto.originalTransactionId,
        refundAmount,
        originalAmount,
        tx,
      );

      const postedJournal = await this.ledger.postJournalEntry(
        {
          referenceType: 'REFUND_PARTIAL',
          referenceId: reversalTransactionId,
          effectiveDate: new Date().toISOString(),
          lines,
          metadata: {
            originalTransactionId: dto.originalTransactionId,
            feePolicy: dto.feePolicy,
            reason: dto.reason,
            reversedBy: actor,
          },
        },
        actor,
        idempotencyKey,
        { checkBalanceOn: [], tx },
      );

      const createdReversal = await (tx as DatabaseService).reversal.create({
        data: {
          id: uuidv7(),
          originalTransactionId: dto.originalTransactionId,
          reversalTransactionId,
          amount: refundAmount.toFixed(4),
          currency,
          feePolicy: dto.feePolicy,
          feeAmountReversed: feeRefund.toFixed(4),
          reason: dto.reason,
          initiatedBy: actor,
          idempotencyKey,
        },
      });

      return { journal: postedJournal, reversalRecord: createdReversal };
    });

    // Transaction has committed — safe to update balance snapshots now
    // (see the `tx` option's contract on LedgerService.postJournalEntry).
    for (const accountId of new Set(journal.entries.map((e) => e.accountId))) {
      const lastEntry = journal.entries.find((e) => e.accountId === accountId);
      if (lastEntry) {
        await this.balance.updateSnapshot(accountId, lastEntry.id);
      }
    }

    this.logger.log(
      `Partial refund posted: original=${dto.originalTransactionId} ` +
        `amount=${refundAmount.toFixed(4)} fee=${feeRefund.toFixed(4)} ` +
        `policy=${dto.feePolicy} by=${actor}`,
    );

    return {
      reversalId: reversalRecord.id,
      originalTransactionId: dto.originalTransactionId,
      reversalTransactionId,
      amountReversed: refundAmount.toFixed(4),
      feeReversed: feeRefund.toFixed(4),
      journalId: journal.journalId,
      postedAt: journal.postedAt,
    };
  }

  /**
   * Cumulative refund guard — total refunded across all partial refunds
   * must never exceed the original transaction amount.
   *
   * This is the "refund ledger pattern" from spec Case Study 4 (Razorpay):
   * derive the total refunded from ledger entries, never from a mutable counter.
   */
  private async assertCumulativeRefundLimit(
    originalTransactionId: string,
    newRefundAmount: Decimal,
    originalAmount: Decimal,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = (tx ?? this.db) as DatabaseService;
    const previousRefunds = await client.reversal.findMany({
      where: { originalTransactionId },
      select: { amount: true },
    });

    const alreadyRefunded = previousRefunds.reduce(
      (sum, r) => sum.plus(new Decimal(r.amount.toString())),
      new Decimal(0),
    );

    const totalAfterThisRefund = alreadyRefunded.plus(newRefundAmount);

    if (totalAfterThisRefund.gt(originalAmount)) {
      throw new UnprocessableEntityException(
        `Cumulative refunds would exceed original amount: ` +
          `already refunded=${alreadyRefunded.toFixed(4)} ` +
          `new refund=${newRefundAmount.toFixed(4)} ` +
          `total=${totalAfterThisRefund.toFixed(4)} ` +
          `original=${originalAmount.toFixed(4)}`,
      );
    }
  }

  private buildReversalResult(record: Reversal): ReversalResult {
    return {
      reversalId: record.id,
      originalTransactionId: record.originalTransactionId,
      reversalTransactionId: record.reversalTransactionId,
      amountReversed: record.amount.toString(),
      feeReversed: record.feeAmountReversed.toString(),
      journalId: '',
      postedAt: record.createdAt.toISOString(),
    };
  }

  /**
   * Prevent a partial refund on a transaction that has already been
   * FULLY reversed. Multiple partial refunds against the same transaction
   * are allowed (up to the cumulative limit) — only a prior FULL reversal
   * blocks further partial refunds, since a full reversal means the
   * transaction's economic effect has already been completely undone.
   */
  private async assertNotFullyReversed(
    transactionId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = (tx ?? this.db) as DatabaseService;
    const originalEntries = await client.ledgerEntry.findMany({
      where: { referenceId: transactionId, status: 'POSTED' },
    });

    const originalAmount = await this.deriveOriginalAmount(originalEntries);

    const priorFullReversal = await client.reversal.findFirst({
      where: {
        originalTransactionId: transactionId,
        feePolicy: 'FULL',
        amount: originalAmount.toFixed(4),
      },
    });

    if (priorFullReversal) {
      throw new ConflictException(
        `Transaction ${transactionId} has already been fully reversed ` +
          `(reversalId: ${priorFullReversal.id}). ` +
          `No further partial refunds can be issued against it.`,
      );
    }
  }

  private async assertNotAlreadyReversed(
    transactionId: string,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = (tx ?? this.db) as DatabaseService;
    const existing = await client.reversal.findFirst({
      where: { originalTransactionId: transactionId },
      orderBy: { createdAt: 'asc' },
    });

    this.logger.debug(
      `assertNotAlreadyReversed check for ${transactionId}: ` +
        `found=${existing ? existing.id : 'none'}`,
    );

    if (existing) {
      throw new ConflictException(
        `Transaction ${transactionId} has already been reversed ` +
          `(reversalId: ${existing.id}). ` +
          `Use partial refund if you need to reverse a different amount.`,
      );
    }
  }
}
