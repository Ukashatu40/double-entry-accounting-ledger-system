// src/transactions/handlers/interest-accrual.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #8 — Interest Accrual (Daily)
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  5003  Interest Expense – Savings  [daily interest amount]
 *   CREDIT 2010  Interest Payable – Savings  [daily interest amount]
 *
 * No balance check — this is a system-initiated accrual entry.
 * The expense and liability both increase; no customer wallet is debited.
 *
 * Daily interest = (principal × annual_rate) / 365
 * Uses NUMERIC precision via decimal.js — never floating point.
 *
 * Validation:
 *   - Annual rate must be between 0 and 1 (e.g. 0.04 = 4% p.a.)
 *   - Principal must be positive
 *   - Day count convention: Actual/365 (fixed)
 */
@Injectable()
export class InterestAccrualHandler extends BaseTransactionHandler {
  protected validateBusinessRules(
    payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): Promise<void> {
    requireSupportedCurrency(payload);

    const principal = parseFloat(String(payload['principal'] ?? '0'));
    const annualRate = parseFloat(String(payload['annualRate'] ?? '0'));

    if (principal <= 0) {
      throw new UnprocessableEntityException('Principal must be positive for interest accrual');
    }

    if (annualRate <= 0 || annualRate > 1) {
      throw new UnprocessableEntityException(
        `Annual rate must be between 0 and 1, got ${annualRate.toString()}`,
      );
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const interestExpense = this.requireAccount(accounts, 'interestExpense');
    const interestPayable = this.requireAccount(accounts, 'interestPayable');

    const principal = new Decimal(String(payload['principal'] ?? '0'));
    const annualRate = new Decimal(String(payload['annualRate'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const accountRef = String(payload['customerAccountRef'] ?? '');

    // Daily interest = (principal × rate) / 365 — Actual/365 day count
    const dailyInterest = principal
      .times(annualRate)
      .dividedBy(365)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    if (dailyInterest.lte(0)) {
      throw new UnprocessableEntityException(
        'Computed daily interest is zero or negative — check principal and rate',
      );
    }

    const interestStr = dailyInterest.toFixed(4);

    return {
      referenceType: 'INTEREST_ACCRUAL',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: interestExpense.id,
          entryType: 'DEBIT',
          amount: interestStr,
          currency,
          narrative: `Daily interest accrual${accountRef ? ` — account ${accountRef}` : ''}`,
        },
        {
          accountId: interestPayable.id,
          entryType: 'CREDIT',
          amount: interestStr,
          currency,
          narrative: `Interest payable accrued${accountRef ? ` — account ${accountRef}` : ''}`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): string[] {
    // System accrual — no balance check needed
    return [];
  }
}
