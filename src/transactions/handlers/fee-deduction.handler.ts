// src/transactions/handlers/fee-deduction.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
// import { computeBalancingLeg } from './balancing-leg.util';
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

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const feeType = String(payload['feeType'] ?? 'Monthly Maintenance Fee');

    return {
      referenceType: 'FEE_DEDUCTION_MONTHLY',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: wallet.id,
          entryType: 'DEBIT',
          amount,
          currency,
          narrative: `${feeType} deducted`,
        },
        {
          accountId: feeRevenue.id,
          entryType: 'CREDIT',
          amount,
          currency,
          narrative: `${feeType} revenue`,
        },
      ],
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
