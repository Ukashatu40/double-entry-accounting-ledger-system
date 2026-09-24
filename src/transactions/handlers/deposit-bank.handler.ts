// src/transactions/handlers/deposit-bank.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #1 — Customer Deposit (Bank Transfer / NEFT / IMPS / RTGS)
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  1001  Customer Wallet – Primary (INR)     [amount]
 *   CREDIT 2001  Customer Deposit Liability           [amount]
 *
 * No balance check needed — this is a FUNDING transaction.
 * The wallet balance increases as a result of this entry.
 *
 * Validation rules:
 *   - Amount must be positive
 *   - Amount must not exceed single-transaction limit (INR 10,00,000)
 *   - Wallet account must be ACTIVE
 */
@Injectable()
export class DepositBankHandler extends BaseTransactionHandler {
  private static readonly MAX_SINGLE_DEPOSIT = '1000000.0000'; // INR 10 lakh

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const walletAccount = this.requireAccount(accounts, 'wallet');
    requireSupportedCurrency(payload);

    if (walletAccount.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Wallet account ${walletAccount.code} is not active`);
    }

    const amount = String(payload['amount'] ?? '0');
    if (parseFloat(amount) > parseFloat(DepositBankHandler.MAX_SINGLE_DEPOSIT)) {
      throw new UnprocessableEntityException(
        `Deposit amount ${amount} exceeds single-transaction limit of ${DepositBankHandler.MAX_SINGLE_DEPOSIT}`,
      );
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const liability = this.requireAccount(accounts, 'liability');
    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const reference = String(payload['reference'] ?? 'NEFT');

    return {
      referenceType: 'CUSTOMER_DEPOSIT_BANK',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: wallet.id,
          entryType: 'DEBIT',
          amount,
          currency,
          narrative: `Customer deposit via ${reference}`,
        },
        {
          accountId: liability.id,
          entryType: 'CREDIT',
          amount,
          currency,
          narrative: `Deposit liability — ${reference} credit`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): string[] {
    // Deposit is a funding transaction — no balance check required
    return [];
  }
}
