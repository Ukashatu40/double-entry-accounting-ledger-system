// src/transactions/handlers/fee-deduction.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #10 — Monthly Maintenance Fee Deduction
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT 1001  Customer Wallet         [fee amount]  (Asset decrease)
 *   CREDIT 4001  Transaction Fee Revenue [fee amount]  (Revenue increase)
 *   DEBIT  1050  Platform Operating Cash [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: previously DEBITed the wallet (per spec A4.2's
 * abbreviated table), which increases an Asset account per Table A1.1 —
 * backwards for a fee deduction. With both "real" legs now correctly
 * signed as CREDIT (wallet decrease + revenue increase), there is no
 * natural debit counterpart between just these two accounts — a Platform
 * Operating Cash debit is required. See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: wallet must have sufficient balance to cover the fee.
 */
@Injectable()
export class FeeDeductionHandler extends BaseTransactionHandler {
  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(
        `Wallet account is not active — fee deduction skipped`,
      );
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Fee amount must be positive');
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected getLimitCheckSpecs(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): { accountId: string; amount: string }[] {
    const wallet = accounts['wallet'];
    if (!wallet) return [];

    const amount = new Decimal(String(payload['amount'] ?? '0')).toFixed(4);
    return [{ accountId: wallet.id, amount }];
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');
    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const feeType = String(payload['feeType'] ?? 'Monthly Maintenance Fee');

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount,
        currency,
        narrative: `${feeType} deducted`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount,
        currency,
        narrative: `${feeType} revenue`,
      },
    ];

    const plug = computeBalancingLeg(realLines);
    const lines = plug
      ? [
          ...realLines,
          {
            accountId: platformCash.id,
            entryType: plug.entryType,
            amount: plug.amount,
            currency,
            narrative: `${feeType} — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'FEE_DEDUCTION_MONTHLY',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): string[] {
    const wallet = accounts['wallet'];
    return wallet ? [wallet.id] : [];
  }
}
