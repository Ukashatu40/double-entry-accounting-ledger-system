// src/transactions/handlers/loan-emi-payment.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #14 — Loan EMI Payment
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT 1001  Customer Wallet             [total EMI = principal + interest]  (Asset decrease)
 *   CREDIT 1020  Loan Receivable – Personal  [principal component]                (Asset decrease — being paid down)
 *   CREDIT 4002  Interest Income – Loans     [interest component]                 (Revenue increase)
 *   DEBIT  1050  Platform Operating Cash     [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: the Loan Receivable and Interest Income legs were
 * already correctly signed (a receivable correctly decreases via CREDIT as
 * it's paid down; revenue correctly increases via CREDIT) — only the
 * wallet leg was backwards (previously DEBIT, per spec A4.2's abbreviated
 * table). With all three "real" legs now correctly signed, all three fall
 * on the credit side, so a Platform Operating Cash debit is required to
 * balance — see docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: customer wallet must have the full EMI amount.
 * Principal and interest split must be provided by caller (from amortisation schedule).
 */
@Injectable()
export class LoanEmiPaymentHandler extends BaseTransactionHandler {
  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Customer wallet is not active');
    }

    const principal = parseFloat(String(payload['principalComponent'] ?? '0'));
    const interest = parseFloat(String(payload['interestComponent'] ?? '0'));

    if (principal < 0) {
      throw new UnprocessableEntityException('Principal component cannot be negative');
    }

    if (interest < 0) {
      throw new UnprocessableEntityException('Interest component cannot be negative');
    }

    if (principal + interest <= 0) {
      throw new UnprocessableEntityException('EMI amount must be positive');
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

    const principal = new Decimal(String(payload['principalComponent'] ?? '0'));
    const interest = new Decimal(String(payload['interestComponent'] ?? '0'));
    const totalEmi = principal.plus(interest).toFixed(4);

    return [{ accountId: wallet.id, amount: totalEmi }];
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const loanReceivable = this.requireAccount(accounts, 'loanReceivable');
    const interestIncome = this.requireAccount(accounts, 'interestIncome');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const principal = new Decimal(String(payload['principalComponent'] ?? '0'));
    const interest = new Decimal(String(payload['interestComponent'] ?? '0'));
    const totalEmi = principal.plus(interest);
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const emiNumber = String(payload['emiNumber'] ?? '');
    const loanRef = String(payload['loanReference'] ?? '');

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount: totalEmi.toFixed(4),
        currency,
        narrative: `EMI payment${emiNumber ? ` #${emiNumber}` : ''}${loanRef ? ` — loan:${loanRef}` : ''}`,
      },
      {
        accountId: loanReceivable.id,
        entryType: 'CREDIT' as const,
        amount: principal.toFixed(4),
        currency,
        narrative: `Principal repayment`,
      },
      {
        accountId: interestIncome.id,
        entryType: 'CREDIT' as const,
        amount: interest.toFixed(4),
        currency,
        narrative: `Interest income on loan`,
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
            narrative: `EMI payment — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'LOAN_EMI_PAYMENT',
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
