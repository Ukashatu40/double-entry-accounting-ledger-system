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
import { LedgerService } from '@ledger/ledger.service';
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

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

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

    // Verify not already reversed
    await this.assertNotFullyReversed(dto.originalTransactionId);

    // Compute total reversed amount for the reversal record
    const totalAmount = originalEntries
      .filter((e) => e.entryType === 'DEBIT')
      .reduce((sum, e) => sum.plus(new Decimal(e.amount.toString())), new Decimal(0));

    const reversalTransactionId = uuidv7();

    // Build the mirror journal entry — flip every debit↔credit
    const mirrorLines = originalEntries.map((e: LedgerEntry) => ({
      accountId: e.accountId,
      entryType: e.entryType === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
      amount: new Decimal(e.amount.toString()).toFixed(4),
      currency: e.currency,
      narrative: `Reversal of entry ${e.id}: ${dto.reason}`,
    }));

    const journal = await this.ledger.postJournalEntry(
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
      { checkBalanceOn: [] },
    );

    // Record the reversal in the reversals table
    const reversalRecord = await this.db.reversal.create({
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

    this.logger.log(
      `Full reversal posted: original=${dto.originalTransactionId} ` +
        `reversal=${reversalTransactionId} amount=${totalAmount.toFixed(4)} by=${actor}`,
    );

    // Mark original transaction as REVERSED
    await this.db.transaction.updateMany({
      where: { id: dto.originalTransactionId },
      data: { status: 'REVERSED' },
    });

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

    await this.assertNotAlreadyReversed(dto.originalTransactionId);

    // Total original amount (sum of all debit lines)
    const originalAmount = originalEntries
      .filter((e) => e.entryType === 'DEBIT')
      .reduce((sum, e) => sum.plus(new Decimal(e.amount.toString())), new Decimal(0));

    const refundAmount = new Decimal(dto.refundAmount);

    // Anti-fraud: refund must never exceed original
    if (refundAmount.gt(originalAmount)) {
      throw new UnprocessableEntityException(
        `Refund amount ${refundAmount.toFixed(4)} exceeds original ` +
          `transaction amount ${originalAmount.toFixed(4)} — (spec A5.2 guard)`,
      );
    }

    // Also check cumulative refunds don't exceed original
    await this.assertCumulativeRefundLimit(dto.originalTransactionId, refundAmount, originalAmount);

    // Fee computation based on policy
    const originalFee = new Decimal(dto.originalFeeAmount ?? '0');
    let feeRefund = new Decimal(0);

    switch (dto.feePolicy) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      case 'FULL':
        feeRefund = originalFee;
        break;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
      case 'PROPORTIONAL':
        feeRefund = originalAmount.gt(0)
          ? refundAmount
              .dividedBy(originalAmount)
              .times(originalFee)
              .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          : new Decimal(0);
        break;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
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

    const journal = await this.ledger.postJournalEntry(
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
      { checkBalanceOn: [] },
    );

    const reversalRecord = await this.db.reversal.create({
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
   * Prevent double-reversals — an already-reversed transaction cannot
   * be reversed again. Checks the reversals table, not a mutable status field.
   */
  private async assertNotAlreadyReversed(transactionId: string): Promise<void> {
    const existing = await this.db.reversal.findFirst({
      where: { originalTransactionId: transactionId },
    });

    if (existing) {
      throw new ConflictException(
        `Transaction ${transactionId} has already been reversed ` +
          `(reversalId: ${existing.id}). ` +
          `Use partial refund if you need to reverse a different amount.`,
      );
    }
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
  ): Promise<void> {
    const previousRefunds = await this.db.reversal.findMany({
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
  private async assertNotFullyReversed(transactionId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    // const fullReversal = await this.db.reversal.findFirst({
    //   where: { originalTransactionId: transactionId, feePolicy: 'FULL', amount: undefined },
    // });
    // A full reversal is recorded with feePolicy: 'FULL' AND amount equal to
    // the entire original amount. We distinguish it from a partial refund
    // that happens to also use the FULL fee policy by checking the reversal
    // was created via reverseTransaction() specifically. Since reverseTransaction()
    // always stores feePolicy: 'FULL', but so can a 100% partial refund, the
    // safest signal is whether reversalTransactionId's referenceType was
    // REFUND_FULL vs REFUND_PARTIAL — stored on the Transaction row itself.
    const transaction = await this.db.transaction.findUnique({
      where: { id: transactionId },
    });
    if (transaction?.status === 'REVERSED') {
      throw new ConflictException(
        `Transaction ${transactionId} has already been fully reversed. ` +
          `No further partial refunds can be issued against it.`,
      );
    }
  }
}
