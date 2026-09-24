// src/ledger/transaction-limit.service.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DatabaseService } from '@database/database.service';
import type { TransactionClient } from '@database/database.service';
import { toDecimal } from '@common/types/money.type';
import type { TransactionType, PrismaClient } from '@prisma/client';

interface SumRow {
  total: string | null;
}

/**
 * Enforces the (previously unused) TransactionLimit table — a real,
 * pre-existing architectural gap this fills: the table has always existed
 * with per-account/per-type max-per-tx/day/month fields, but no handler
 * ever queried it; limits were hardcoded constants per handler class
 * instead. This service is generic (not NGN-specific) and opt-in per
 * handler via BaseTransactionHandler.getLimitCheckSpecs() — see that
 * file's doc comment for the wiring contract.
 *
 * Lives in src/ledger/ (not src/transactions/, despite being consumed
 * there) so LedgerService can inject it directly without TransactionsModule
 * ↔ LedgerModule becoming a cycle — TransactionsModule already imports
 * LedgerModule, so this way both get it from the same place.
 *
 * CONCURRENCY: the day/month aggregate check requires a `tx` (see
 * LedgerService.postJournalEntry(), which calls this from inside its own
 * advisory-locked transaction) to avoid the exact TOCTOU shape fixed for
 * refunds in reversals.service.ts — two concurrent transactions against the
 * same account+type could otherwise both read the same "already posted"
 * total before either commits, and both pass. Without a `tx` (the default),
 * the check runs unguarded against `this.db` — acceptable only for callers
 * that don't need the stronger guarantee, or that provide their own locking.
 */
@Injectable()
export class TransactionLimitService {
  constructor(private readonly db: DatabaseService) {}

  async assertWithinLimits(
    accountId: string,
    transactionType: TransactionType,
    amount: Decimal,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = (tx ?? this.db) as unknown as PrismaClient;

    const limit = await client.transactionLimit.findUnique({
      where: { accountId_transactionType: { accountId, transactionType } },
    });

    if (!limit || !limit.isActive) return; // no limit configured — pass through

    if (limit.maxPerTx !== null && amount.gt(toDecimal(limit.maxPerTx.toString()))) {
      throw new UnprocessableEntityException(
        `Amount ${amount.toFixed(4)} exceeds per-transaction limit of ${limit.maxPerTx.toString()}`,
      );
    }

    if (limit.maxPerDay !== null) {
      const todayTotal = await this.sumPostedAmount(accountId, transactionType, startOfDay(), tx);
      const projected = todayTotal.plus(amount);
      if (projected.gt(toDecimal(limit.maxPerDay.toString()))) {
        throw new UnprocessableEntityException(
          `Amount ${amount.toFixed(4)} would exceed daily limit of ${limit.maxPerDay.toString()} ` +
            `(already posted today: ${todayTotal.toFixed(4)})`,
        );
      }
    }

    if (limit.maxPerMonth !== null) {
      const monthTotal = await this.sumPostedAmount(accountId, transactionType, startOfMonth(), tx);
      const projected = monthTotal.plus(amount);
      if (projected.gt(toDecimal(limit.maxPerMonth.toString()))) {
        throw new UnprocessableEntityException(
          `Amount ${amount.toFixed(4)} would exceed monthly limit of ${limit.maxPerMonth.toString()} ` +
            `(already posted this month: ${monthTotal.toFixed(4)})`,
        );
      }
    }
  }

  private async sumPostedAmount(
    accountId: string,
    transactionType: TransactionType,
    since: Date,
    tx?: TransactionClient,
  ): Promise<Decimal> {
    const client = (tx ?? this.db) as unknown as PrismaClient;
    const rows = await client.$queryRaw<SumRow[]>`
      SELECT COALESCE(SUM(amount), 0)::TEXT AS total
      FROM ledger_entries
      WHERE account_id = ${accountId}
        AND reference_type = ${transactionType}::"TransactionType"
        AND status = 'POSTED'
        AND effective_date >= ${since}
    `;
    return toDecimal(rows[0]?.total ?? '0');
  }
}

function startOfDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
