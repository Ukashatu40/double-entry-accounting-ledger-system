// src/reporting/trial-balance.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@database/database.service';
import { normalBalanceSign, toDecimal } from '@common/types/money.type';
import Decimal from 'decimal.js';
import type { AccountType } from '@prisma/client';

export interface TrialBalanceLine {
  accountCode: string;
  accountName: string;
  accountType: string;
  currency: string;
  totalDebits: string;
  totalCredits: string;
  netBalance: string;
}

export interface TrialBalanceReport {
  asOfDate: string;
  generatedAt: string;
  lines: TrialBalanceLine[];
  grandTotalDebits: string;
  grandTotalCredits: string;
  isBalanced: boolean;
  discrepancy: string;
}

interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  account_type: string;
  currency: string;
  total_debits: string;
  total_credits: string;
  net_balance: string;
}

@Injectable()
export class TrialBalanceService {
  private readonly logger = new Logger(TrialBalanceService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Generate a trial balance as of any historical date.
   *
   * The query aggregates all POSTED ledger entries up to and including
   * the given date, grouped by account.
   *
   * SPEC ERROR CORRECTION (Part A6.1, page 17):
   * The spec's trial balance SQL computes net_balance as:
   *   SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END)
   * This is wrong — it gives a raw debit-minus-credit which has different
   * meaning per account type. We keep this raw value for the math check
   * (debits must equal credits globally), but multiply by normalBalanceSign()
   * before display so a credit-normal account (LIABILITY/EQUITY/REVENUE)
   * with a credit balance shows as positive, not negative — matching the
   * same correction already applied in account-statement.service.ts.
   *
   * The global invariant is:
   *   SUM(all debits) = SUM(all credits)
   * which is equivalent to:
   *   SUM(net_balance across all accounts) = 0
   */
  async generate(asOfDate?: Date): Promise<TrialBalanceReport> {
    const asOf = asOfDate ?? new Date();

    const rows = await this.db.$queryRaw<TrialBalanceRow[]>`
      SELECT
        a.code               AS account_code,
        a.name               AS account_name,
        a.type               AS account_type,
        a.currency           AS currency,
        COALESCE(
          SUM(CASE WHEN le.entry_type = 'DEBIT'  THEN le.amount ELSE 0 END),
          0
        )::TEXT              AS total_debits,
        COALESCE(
          SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE 0 END),
          0
        )::TEXT              AS total_credits,
        COALESCE(
          SUM(
            CASE WHEN le.entry_type = 'DEBIT'
                 THEN le.amount
                 ELSE -le.amount
            END
          ),
          0
        )::TEXT              AS net_balance
      FROM accounts a
      LEFT JOIN ledger_entries le
        ON le.account_id = a.id
        AND le.status = 'POSTED'
        AND le.effective_date <= ${asOf}
      GROUP BY a.code, a.name, a.type, a.currency
      ORDER BY a.code
    `;

    let grandTotalDebits = new Decimal(0);
    let grandTotalCredits = new Decimal(0);

    const lines: TrialBalanceLine[] = rows.map((row) => {
      const debits = toDecimal(row.total_debits);
      const credits = toDecimal(row.total_credits);
      grandTotalDebits = grandTotalDebits.plus(debits);
      grandTotalCredits = grandTotalCredits.plus(credits);

      const sign = normalBalanceSign(row.account_type as AccountType);

      return {
        accountCode: row.account_code,
        accountName: row.account_name,
        accountType: row.account_type,
        currency: row.currency,
        totalDebits: debits.toFixed(4),
        totalCredits: credits.toFixed(4),
        netBalance: toDecimal(row.net_balance).times(sign).toFixed(4),
      };
    });

    const discrepancy = grandTotalDebits.minus(grandTotalCredits);
    const isBalanced = discrepancy.equals(0);

    if (!isBalanced) {
      this.logger.error(
        `Trial balance DISCREPANCY detected: debits=${grandTotalDebits.toFixed(4)} ` +
          `credits=${grandTotalCredits.toFixed(4)} diff=${discrepancy.toFixed(4)}`,
      );
    } else {
      this.logger.log(
        `Trial balance OK: total=${grandTotalDebits.toFixed(4)} as of ${asOf.toISOString()}`,
      );
    }

    return {
      asOfDate: asOf.toISOString(),
      generatedAt: new Date().toISOString(),
      lines,
      grandTotalDebits: grandTotalDebits.toFixed(4),
      grandTotalCredits: grandTotalCredits.toFixed(4),
      isBalanced,
      discrepancy: discrepancy.toFixed(4),
    };
  }
}
