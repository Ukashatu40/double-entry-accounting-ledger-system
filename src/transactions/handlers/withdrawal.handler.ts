// src/transactions/handlers/withdrawal.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #3 — Customer Withdrawal (Bank Transfer)
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  2001  Customer Deposit Liability   [amount]
 *   CREDIT 1001  Customer Wallet – Primary    [amount]
 *
 * Balance check: wallet account (1001) must have sufficient funds.
 *
 * NOTE: The debit is on the Liability account (reducing what we owe the customer)
 * and the credit is on the Asset account (reducing our asset).
 * Balance check runs on the WALLET (asset) account — its raw debit-minus-credit
 * balance must be >= the withdrawal amount.
 */
@Injectable()
export class WithdrawalHandler extends BaseTransactionHandler {
  private static readonly MAX_DAILY_WITHDRAWAL = '100000.0000'; // INR 1 lakh/day

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const walletAccount = this.requireAccount(accounts, 'wallet');

    if (walletAccount.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Wallet account ${walletAccount.code} is not active`);
    }

    requireSupportedCurrency(payload);

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount > parseFloat(WithdrawalHandler.MAX_DAILY_WITHDRAWAL)) {
      throw new UnprocessableEntityException(
        `Withdrawal amount exceeds daily limit of ${WithdrawalHandler.MAX_DAILY_WITHDRAWAL}`,
      );
    }

    return Promise.resolve();
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
    const liability = this.requireAccount(accounts, 'liability');
    const amount = String(payload['amount'] ?? '');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const beneficiary = String(payload['beneficiary'] ?? 'Bank Account');

    return {
      referenceType: 'CUSTOMER_WITHDRAWAL_BANK',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: liability.id,
          entryType: 'DEBIT',
          amount,
          currency,
          narrative: `Withdrawal to ${beneficiary} — liability reduced`,
        },
        {
          accountId: wallet.id,
          entryType: 'CREDIT',
          amount,
          currency,
          narrative: `Withdrawal to ${beneficiary} — wallet debited`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): string[] {
    // Check the wallet balance before crediting (reducing) it
    const wallet = accounts['wallet'];
    return wallet ? [wallet.id] : [];
  }
}
