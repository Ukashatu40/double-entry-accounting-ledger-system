// src/transactions/transaction-limit.service.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DatabaseService } from '@database/database.service';
import { toDecimal } from '@common/types/money.type';
import type { TransactionType } from '@prisma/client';

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
 * KNOWN LIMITATION (documented, not fixed here — out of scope for this
 * change, which targets the 4 confirmed bugs plus NGN localization): the
 * day/month aggregate check below has its own check-then-act window,
 * structurally like the refund TOCTOU bug fixed in reversals.service.ts,
 * but for spend limits rather than refunds. A future hardening pass should
 * thread this check into LedgerService.postJournalEntry()'s existing
 * advisory-locked transaction (piggybacking on the same per-account lock
 * already acquired there for balance checks) rather than checking before
 * that lock is taken.
 */
@Injectable()
export class TransactionLimitService {
  constructor(private readonly db: DatabaseService) {}

  async assertWithinLimits(
    accountId: string,
    transactionType: TransactionType,
    amount: Decimal,
  ): Promise<void> {
    const limit = await this.db.transactionLimit.findUnique({
      where: { accountId_transactionType: { accountId, transactionType } },
    });

    if (!limit || !limit.isActive) return; // no limit configured — pass through

    if (limit.maxPerTx !== null && amount.gt(toDecimal(limit.maxPerTx.toString()))) {
      throw new UnprocessableEntityException(
        `Amount ${amount.toFixed(4)} exceeds per-transaction limit of ${limit.maxPerTx.toString()}`,
      );
    }

    if (limit.maxPerDay !== null) {
      const todayTotal = await this.sumPostedAmount(accountId, transactionType, startOfDay());
      const projected = todayTotal.plus(amount);
      if (projected.gt(toDecimal(limit.maxPerDay.toString()))) {
        throw new UnprocessableEntityException(
          `Amount ${amount.toFixed(4)} would exceed daily limit of ${limit.maxPerDay.toString()} ` +
            `(already posted today: ${todayTotal.toFixed(4)})`,
        );
      }
    }

    if (limit.maxPerMonth !== null) {
      const monthTotal = await this.sumPostedAmount(accountId, transactionType, startOfMonth());
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
  ): Promise<Decimal> {
    const rows = await this.db.$queryRaw<SumRow[]>`
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
