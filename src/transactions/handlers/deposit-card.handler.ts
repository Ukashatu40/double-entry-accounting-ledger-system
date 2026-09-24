// src/transactions/handlers/deposit-card.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #2 — Customer Deposit (Card)
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  1001  Customer Wallet – Primary     [amount]
 *   CREDIT 2001  Customer Deposit Liability     [amount]
 *   DEBIT  5001  Payment Gateway Fees Expense  [gateway fee]
 *   CREDIT 2002  Merchant Payable – Pending    [gateway fee]
 *
 * No balance check — funding transaction.
 * Gateway fee is borne by the platform (not the customer).
 */
@Injectable()
export class DepositCardHandler extends BaseTransactionHandler {
  private static readonly GATEWAY_FEE_RATE = 0.018; // 1.8% typical card fee
  private static readonly MAX_AMOUNT = '500000.0000';

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
      throw new UnprocessableEntityException('Deposit amount must be positive');
    }

    if (amount > parseFloat(DepositCardHandler.MAX_AMOUNT)) {
      throw new UnprocessableEntityException(
        `Card deposit exceeds limit of ${DepositCardHandler.MAX_AMOUNT}`,
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
    const gatewayExpense = this.requireAccount(accounts, 'gatewayExpense');
    const merchantPayable = this.requireAccount(accounts, 'merchantPayable');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const cardLast4 = String(payload['cardLast4'] ?? '****');
    const network = String(payload['network'] ?? 'CARD');

    const gatewayFee = amount
      .times(DepositCardHandler.GATEWAY_FEE_RATE)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    return {
      referenceType: 'CUSTOMER_DEPOSIT_CARD',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: wallet.id,
          entryType: 'DEBIT',
          amount: amount.toFixed(4),
          currency,
          narrative: `Card deposit via ${network} ending ${cardLast4}`,
        },
        {
          accountId: liability.id,
          entryType: 'CREDIT',
          amount: amount.toFixed(4),
          currency,
          narrative: `Deposit liability — card credit`,
        },
        {
          accountId: gatewayExpense.id,
          entryType: 'DEBIT',
          amount: gatewayFee.toFixed(4),
          currency,
          narrative: `Card gateway fee — 1.8% of ${amount.toFixed(4)}`,
        },
        {
          accountId: merchantPayable.id,
          entryType: 'CREDIT',
          amount: gatewayFee.toFixed(4),
          currency,
          narrative: `Gateway fee payable to card network`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
