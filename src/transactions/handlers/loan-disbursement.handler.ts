// src/transactions/handlers/loan-disbursement.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #13 — Loan Disbursement
 *
 * Journal pattern (spec A4.2):
 *   DEBIT  1001  Customer Wallet             [net disbursement = principal - processing fee]
 *   DEBIT  5001  Processing Fee Expense      [processing fee]  ← platform cost
 *   CREDIT 1020  Loan Receivable – Personal  [principal]
 *
 * No balance check — the loan creates a new receivable asset.
 * Processing fee (1% of principal) is deducted from disbursement upfront.
 */
@Injectable()
export class LoanDisbursementHandler extends BaseTransactionHandler {
  private static readonly PROCESSING_FEE_RATE = new Decimal('0.01');
  private static readonly MAX_LOAN = '5000000.0000'; // INR 50 lakh

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    requireSupportedCurrency(payload);

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Customer wallet is not active');
    }

    const principal = parseFloat(String(payload['principal'] ?? '0'));
    if (principal <= 0) {
      throw new UnprocessableEntityException('Loan principal must be positive');
    }

    if (principal > parseFloat(LoanDisbursementHandler.MAX_LOAN)) {
      throw new UnprocessableEntityException(
        `Loan amount exceeds maximum of ${LoanDisbursementHandler.MAX_LOAN}`,
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
    const loanReceivable = this.requireAccount(accounts, 'loanReceivable');
    const gatewayExpense = this.requireAccount(accounts, 'gatewayExpense');

    const principal = new Decimal(String(payload['principal'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const loanRef = String(payload['loanReference'] ?? '');

    const processingFee = principal
      .times(LoanDisbursementHandler.PROCESSING_FEE_RATE)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const netDisbursement = principal.minus(processingFee);

    return {
      referenceType: 'LOAN_DISBURSEMENT',
      referenceId: transactionId,
      effectiveDate,
      lines: [
        {
          accountId: wallet.id,
          entryType: 'DEBIT',
          amount: netDisbursement.toFixed(4),
          currency,
          narrative: `Loan disbursement net of processing fee${loanRef ? ` — ref:${loanRef}` : ''}`,
        },
        {
          accountId: gatewayExpense.id,
          entryType: 'DEBIT',
          amount: processingFee.toFixed(4),
          currency,
          narrative: `Loan processing fee — 1% of ${principal.toFixed(4)}`,
        },
        {
          accountId: loanReceivable.id,
          entryType: 'CREDIT',
          amount: principal.toFixed(4),
          currency,
          narrative: `Loan receivable created${loanRef ? ` — ref:${loanRef}` : ''}`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
