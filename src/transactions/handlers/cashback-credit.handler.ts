// src/transactions/handlers/cashback-credit.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #11 — Cashback Credit
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   DEBIT  5002  Cashback Expense       [cashback amount]  (Expense increase — already correct pre-fix)
 *   DEBIT  1001  Customer Wallet        [cashback amount]  (Asset increase — customer receives money)
 *   CREDIT 1050  Platform Operating Cash [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: the Cashback Expense leg was already correctly
 * signed. Only the wallet leg was backwards — previously CREDITed
 * (decreasing the customer's balance) when the customer is actually
 * *receiving* cashback, which should DEBIT (increase) an Asset account
 * per Table A1.1. With both real legs now correctly DEBITed, a Platform
 * Operating Cash credit is required to fund/balance the entry — this
 * represents the bank's own operating cash funding the giveaway. See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * No balance check — funding transaction from platform to customer.
 */
@Injectable()
export class CashbackCreditHandler extends BaseTransactionHandler {
  private static readonly MAX_CASHBACK = '10000.0000';

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    requireSupportedCurrency(payload);

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Customer wallet is not active');
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Cashback amount must be positive');
    }

    if (amount > parseFloat(CashbackCreditHandler.MAX_CASHBACK)) {
      throw new UnprocessableEntityException(
        `Cashback amount exceeds per-transaction cap of ${CashbackCreditHandler.MAX_CASHBACK}`,
      );
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const cashbackExpense = this.requireAccount(accounts, 'cashbackExpense');
    const wallet = this.requireAccount(accounts, 'wallet');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const campaignId = String(payload['campaignId'] ?? '');
    const reason = String(payload['reason'] ?? 'Cashback reward');

    const realLines = [
      {
        accountId: cashbackExpense.id,
        entryType: 'DEBIT' as const,
        amount,
        currency,
        narrative: `${reason}${campaignId ? ` — campaign:${campaignId}` : ''}`,
      },
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount,
        currency,
        narrative: `Cashback credited to wallet`,
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
            narrative: `Cashback credit — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'CASHBACK_CREDIT',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
