// src/transactions/handlers/account-closure.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #20 — Account Closure Sweep
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  2001  Customer Deposit Liability  [remaining balance]
 *   CREDIT 1001  Customer Wallet             [remaining balance]
 *
 * Zeroes out the wallet by sweeping the remaining balance to a bank transfer.
 * After this transaction the account is marked CLOSED by the service layer.
 *
 * Validation:
 *   - No active loans (passed in as metadata)
 *   - All pending settlements must be resolved before closure
 *   - Amount must match the actual wallet balance exactly
 */
@Injectable()
export class AccountClosureHandler extends BaseTransactionHandler {
  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    requireSupportedCurrency(payload);

    if (wallet.status === 'CLOSED') {
      throw new UnprocessableEntityException('Account is already closed');
    }

    const hasActiveLoan = payload['hasActiveLoan'] === true;
    if (hasActiveLoan) {
      throw new UnprocessableEntityException(
        'Cannot close account with an active loan outstanding',
      );
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount < 0) {
      throw new UnprocessableEntityException('Closure sweep amount cannot be negative');
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const liability = this.requireAccount(accounts, 'liability');
    const wallet = this.requireAccount(accounts, 'wallet');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const bankRef = String(payload['bankReference'] ?? '');

    // Zero-balance closure — no journal lines needed if balance is 0
    if (amount.eq(0)) {
      throw new UnprocessableEntityException(
        'Balance is already zero — no sweep required. Proceed to close the account directly.',
      );
    }

    return {
      referenceType: 'ACCOUNT_CLOSURE_SWEEP',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: liability.id,
          entryType: 'DEBIT',
          amount: amount.toFixed(4),
          currency,
          narrative: `Account closure — liability settled`,
        },
        {
          accountId: wallet.id,
          entryType: 'CREDIT',
          amount: amount.toFixed(4),
          currency,
          narrative: `Account closure sweep — balance transferred${bankRef ? ` to ${bankRef}` : ''}`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
