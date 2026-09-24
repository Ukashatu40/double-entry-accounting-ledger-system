// src/ledger/ledger.service.ts
import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import Decimal from 'decimal.js';
import { DatabaseService } from '@database/database.service';
import type { TransactionClient } from '@database/database.service';
import { HashChainService } from './hash-chain.service';
import { LedgerRepository } from './ledger.repository';
import { BalanceService } from './balance.service';
import { TransactionLimitService } from './transaction-limit.service';
import { assertBalanced, toDecimal } from '@common/types/money.type';
import type { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import type { LedgerEntry, TransactionType } from '@prisma/client';

export interface PostedJournal {
  journalId: string;
  entries: LedgerEntry[];
  totalDebits: string;
  totalCredits: string;
  postedAt: string;
}

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly hashChain: HashChainService,
    private readonly repo: LedgerRepository,
    private readonly balance: BalanceService,
    private readonly limits: TransactionLimitService,
  ) {}

  /**
   * Post a journal entry to the ledger.
   *
   * This is the core of the double-entry engine. Every financial event
   * in the system flows through here. The method:
   *
   *   1. Validates debits === credits (assertBalanced)
   *   2. Validates all amounts are positive
   *   3. Acquires advisory locks on all affected accounts (ordered)
   *   4. For debit lines: verifies sufficient balance
   *   5. Fetches the last entry's hash (FOR UPDATE — prevents race)
   *   6. Computes SHA-256 hash for each new entry
   *   7. Inserts all lines atomically (BEGIN...COMMIT)
   *   8. Updates balance snapshots after commit
   *
   * If ANY step fails, the entire transaction rolls back.
   * No partial journal entries can exist in the database.
   */
  async postJournalEntry(
    dto: CreateJournalEntryDto,
    createdBy: string,
    idempotencyKey?: string,
    options?: {
      // Account IDs to check balance on before debiting.
      // Leave empty for funding transactions (deposits, loan disbursements).
      // Provide debit account IDs for spending transactions (withdrawals, payments).
      checkBalanceOn?: string[];
      // Account+type spend caps to enforce before posting, checked INSIDE
      // the same advisory-locked transaction as the balance check below —
      // this is what closes the TOCTOU window TransactionLimitService would
      // otherwise have on its own (see that file's doc comment): two
      // concurrent posts against the same account+type now genuinely
      // serialize on the advisory lock instead of both reading the same
      // "already posted today" total before either commits.
      limitChecks?: { accountId: string; transactionType: TransactionType; amount: string }[];
      // An existing transaction client to post into, instead of opening a new
      // one. Use this when the caller owns a wider transaction boundary that
      // must commit/rollback atomically with this journal post (e.g. a
      // refund's cumulative-limit check + journal post + Reversal row insert
      // all need to be one atomic unit — see reversals.service.ts).
      //
      // CONTRACT: when `tx` is supplied, this method does NOT update balance
      // snapshots after posting (the post-commit snapshot read goes through
      // the top-level `this.db` connection, outside the caller's still-open
      // transaction, and would see stale data). The caller is responsible
      // for calling `BalanceService.updateSnapshot()` for every affected
      // account once its own transaction has committed.
      tx?: TransactionClient;
    },
  ): Promise<PostedJournal> {
    // ── Step 1: Validate balance ─────────────────────────────────────────────
    const lines = dto.lines.map((l) => ({
      ...l,
      amountDecimal: toDecimal(l.amount),
    }));

    for (const line of lines) {
      if (line.amountDecimal.lte(0)) {
        throw new UnprocessableEntityException(
          `Amount must be positive, got ${line.amountDecimal.toFixed(4)} on account ${line.accountId}`,
        );
      }
    }

    assertBalanced(lines.map((l) => ({ entryType: l.entryType, amount: l.amountDecimal })));

    const journalId = uuidv7();
    const effectiveDate = new Date(dto.effectiveDate);

    // Only lock and check balance on explicitly specified accounts
    const balanceCheckAccountIds = options?.checkBalanceOn ?? [];
    const limitChecks = options?.limitChecks ?? [];
    // Union: any account needing a balance check OR a limit check gets
    // locked, so the limit check below is genuinely serialized too.
    const lockAccountIds = [
      ...new Set([...balanceCheckAccountIds, ...limitChecks.map((c) => c.accountId)]),
    ];

    // NOTE: `entries` is built fresh inside `run` (not accumulated in an
    // outer-scoped array) so that if withRetryTransaction retries this
    // callback after a conflict, the rolled-back attempt's entries are
    // discarded along with it rather than polluting the final result with
    // phantom rows that were never actually committed.
    const run = async (tx: TransactionClient): Promise<LedgerEntry[]> => {
      const entries: LedgerEntry[] = [];

      // Acquire advisory locks on every account we need to balance-check
      // and/or limit-check
      if (lockAccountIds.length > 0) {
        await this.db.acquireAdvisoryLocks(tx, lockAccountIds);
      }

      // Check balance only on the specified accounts
      for (const accountId of balanceCheckAccountIds) {
        const line = lines.find((l) => l.accountId === accountId);
        if (!line) continue;

        const currentBalance = await this.balance.deriveBalanceLocked(tx, accountId);

        if (currentBalance.lt(line.amountDecimal)) {
          throw new UnprocessableEntityException(
            `Insufficient balance on account ${accountId}: ` +
              `available=${currentBalance.toFixed(4)} ${line.currency} ` +
              `requested=${line.amountDecimal.toFixed(4)} ${line.currency}`,
          );
        }
      }

      // Check TransactionLimit caps, now serialized by the same advisory
      // lock acquired above.
      for (const check of limitChecks) {
        await this.limits.assertWithinLimits(
          check.accountId,
          check.transactionType,
          toDecimal(check.amount),
          tx,
        );
      }

      // Get last entry hash to continue the chain
      const lastEntry = await this.repo.getLastPostedEntry(tx);
      let previousHash = lastEntry?.hash ?? this.hashChain.getGenesisHash();

      for (const line of dto.lines) {
        const entryId = uuidv7();
        const amountStr = toDecimal(line.amount).toFixed(4);

        const { hash } = this.hashChain.computeHash(
          {
            id: entryId,
            journalId,
            accountId: line.accountId,
            entryType: line.entryType,
            amount: amountStr,
            currency: line.currency,
            effectiveDate: effectiveDate.toISOString(),
            createdBy,
            referenceType: dto.referenceType,
            referenceId: dto.referenceId,
            narrative: line.narrative,
          },
          previousHash,
        );

        this.logger.debug(
          `Hash input for entry ${entryId}: ` +
            `${entryId}|${journalId}|${line.accountId}|${line.entryType}|` +
            `${amountStr}|${line.currency}|${effectiveDate.toISOString()}|` +
            `${createdBy}|${dto.referenceType}|${dto.referenceId}|${line.narrative}|${previousHash}`,
        );

        const insertData: Parameters<typeof this.repo.insertEntry>[1] = {
          id: entryId,
          journalId,
          accountId: line.accountId,
          entryType: line.entryType,
          amount: amountStr,
          currency: line.currency,
          effectiveDate,
          createdBy,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          narrative: line.narrative,
          hash,
          previousHash,
        };

        if (idempotencyKey !== undefined) insertData.idempotencyKey = idempotencyKey;
        if (dto.metadata !== undefined) insertData.metadata = dto.metadata;

        const entry = await this.repo.insertEntry(tx, insertData);

        entries.push(entry);
        previousHash = hash;
      }

      return entries;
    };

    const postedEntries = options?.tx
      ? await run(options.tx)
      : await this.db.withRetryTransaction(run);

    // See the `tx` option's doc comment: when the caller supplied its own
    // transaction, it hasn't committed yet at this point, so updating
    // snapshots here (via the top-level `this.db` connection) would read
    // stale data. The caller updates snapshots itself after its commit.
    if (!options?.tx) {
      const affectedAccountIds = [...new Set(dto.lines.map((l) => l.accountId))];
      for (const accountId of affectedAccountIds) {
        const lastEntry = postedEntries.find((e) => e.accountId === accountId);
        if (lastEntry) {
          await this.balance.updateSnapshot(accountId, lastEntry.id);
        }
      }
    }

    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);
    for (const line of lines) {
      if (line.entryType === 'DEBIT') totalDebits = totalDebits.plus(line.amountDecimal);
      else totalCredits = totalCredits.plus(line.amountDecimal);
    }

    this.logger.log(
      `Journal posted: journalId=${journalId} entries=${postedEntries.length.toString()} ` +
        `debits=${totalDebits.toFixed(4)} credits=${totalCredits.toFixed(4)} by=${createdBy}`,
    );

    return {
      journalId,
      entries: postedEntries,
      totalDebits: totalDebits.toFixed(4),
      totalCredits: totalCredits.toFixed(4),
      postedAt: new Date().toISOString(),
    };
  }

  async getJournalEntries(journalId: string): Promise<LedgerEntry[]> {
    return this.repo.findByJournalId(journalId);
  }

  async getAccountEntries(accountId: string, from?: Date, to?: Date): Promise<LedgerEntry[]> {
    return this.repo.findByAccountId(accountId, from, to);
  }

  async getAccountBalance(accountId: string): Promise<string> {
    const { balance } = await this.balance.deriveBalance(accountId);
    return balance;
  }
}
