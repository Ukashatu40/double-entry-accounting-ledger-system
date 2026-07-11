// src/transactions/handlers/promotional-credit.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #12 — Promotional Credit
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   DEBIT  5002  Marketing Expense       [promo amount]  (Expense increase — already correct pre-fix)
 *   DEBIT  1001  Customer Wallet         [promo amount]  (Asset increase — customer receives credit)
 *   CREDIT 1050  Platform Operating Cash [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: same pattern as cashback-credit — the wallet leg was
 * backwards (previously CREDITed, decreasing balance, when the customer
 * is receiving the credit). See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Validation:
 *   - Promo code must be present
 *   - Amount must be positive
 */
@Injectable()
export class PromotionalCreditHandler extends BaseTransactionHandler {
  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Customer wallet is not active');
    }

    const promoCode = String(payload['promoCode'] ?? '');
    if (!promoCode) {
      throw new UnprocessableEntityException('promoCode is required for promotional credits');
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Promotional credit amount must be positive');
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const marketingExpense = this.requireAccount(accounts, 'cashbackExpense');
    const wallet = this.requireAccount(accounts, 'wallet');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const promoCode = String(payload['promoCode'] ?? '');

    const realLines = [
      {
        accountId: marketingExpense.id,
        entryType: 'DEBIT' as const,
        amount,
        currency,
        narrative: `Promotional credit — code:${promoCode}`,
      },
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount,
        currency,
        narrative: `Promo credit applied — code:${promoCode}`,
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
            narrative: `Promotional credit — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'PROMOTIONAL_CREDIT',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
