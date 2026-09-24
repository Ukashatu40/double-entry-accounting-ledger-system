// src/transactions/handlers/loan-emi-payment.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #14 — Loan EMI Payment
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT 1001  Customer Wallet             [amount actually paid]        (Asset decrease)
 *   CREDIT 1020  Loan Receivable – Personal  [principal applied]           (Asset decrease — paid down)
 *   CREDIT 4002  Interest Income – Loans     [interest applied]            (Revenue increase)
 *   CREDIT 4020  Penalty Interest Revenue    [penalty applied]             (Revenue increase, only if overdue)
 *   DEBIT  1050  Platform Operating Cash     [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: the Loan Receivable and Interest Income legs were
 * already correctly signed (a receivable correctly decreases via CREDIT as
 * it's paid down; revenue correctly increases via CREDIT) — only the
 * wallet leg was backwards (previously DEBIT, per spec A4.2's abbreviated
 * table). See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * OVERDUE PENALTY + PAYMENT WATERFALL (spec Scenario 3, flagged as missing
 * in code review — this handler previously just posted whatever
 * principal/interest split the caller supplied, with no penalty logic and
 * no defined allocation order):
 *
 *   1. If `daysOverdue` > 0, a penalty accrues linearly on the scheduled
 *      EMI amount: penalty = (scheduledPrincipal + scheduledInterest) ×
 *      PENALTY_RATE_PER_DAY × daysOverdue. Posted to account 4020 (Penalty
 *      Interest Revenue), which existed in the Chart of Accounts before
 *      this change but nothing ever posted to it.
 *   2. `paymentAmount` (what the customer is actually paying — defaults to
 *      exactly scheduledPrincipal + scheduledInterest, i.e. an on-time
 *      payment with no penalty and no prepayment) is applied via a
 *      standard loan-servicing waterfall: penalty first, then interest,
 *      then principal. Any amount beyond the scheduled principal + interest
 *      + penalty is prepayment and reduces the loan receivable further.
 *      A payment that doesn't cover the full amount due (penalty + full
 *      scheduled interest + full scheduled principal) is rejected — this
 *      ledger has no "penalty receivable" or "interest receivable" account
 *      to carry a partial shortfall on, so partial/short EMI payments
 *      aren't modeled (a real system would need a dedicated loan-schedule
 *      entity to track that; out of scope here — see the illustrative
 *      framing throughout this handler).
 *
 * Balance check: customer wallet must have the full payment amount.
 */
@Injectable()
export class LoanEmiPaymentHandler extends BaseTransactionHandler {
  private static readonly PENALTY_RATE_PER_DAY = new Decimal('0.001'); // 0.1%/day, illustrative

  private computeAmounts(payload: Record<string, unknown>): {
    scheduledPrincipal: Decimal;
    scheduledInterest: Decimal;
    daysOverdue: number;
    penalty: Decimal;
    totalDue: Decimal;
    paymentAmount: Decimal;
    penaltyApplied: Decimal;
    interestApplied: Decimal;
    principalApplied: Decimal;
  } {
    const scheduledPrincipal = new Decimal(String(payload['scheduledPrincipal'] ?? '0'));
    const scheduledInterest = new Decimal(String(payload['scheduledInterest'] ?? '0'));
    const daysOverdue = Math.max(0, parseInt(String(payload['daysOverdue'] ?? '0'), 10) || 0);

    const scheduledTotal = scheduledPrincipal.plus(scheduledInterest);
    const penalty =
      daysOverdue > 0
        ? scheduledTotal
            .times(LoanEmiPaymentHandler.PENALTY_RATE_PER_DAY)
            .times(daysOverdue)
            .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
        : new Decimal(0);

    const totalDue = scheduledTotal.plus(penalty);
    const paymentAmount = new Decimal(String(payload['paymentAmount'] ?? totalDue.toFixed(4)));

    // Waterfall: penalty first, then interest, then principal (standard
    // loan-servicing allocation order). Any surplus beyond totalDue is
    // extra principal paydown (prepayment).
    let remaining = paymentAmount;
    const penaltyApplied = Decimal.min(remaining, penalty);
    remaining = remaining.minus(penaltyApplied);
    const interestApplied = Decimal.min(remaining, scheduledInterest);
    remaining = remaining.minus(interestApplied);
    const principalApplied = remaining; // scheduled principal + any prepayment surplus

    return {
      scheduledPrincipal,
      scheduledInterest,
      daysOverdue,
      penalty,
      totalDue,
      paymentAmount,
      penaltyApplied,
      interestApplied,
      principalApplied,
    };
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

    const { scheduledPrincipal, scheduledInterest, totalDue, paymentAmount } =
      this.computeAmounts(payload);

    if (scheduledPrincipal.lt(0)) {
      throw new UnprocessableEntityException('Principal component cannot be negative');
    }

    if (scheduledInterest.lt(0)) {
      throw new UnprocessableEntityException('Interest component cannot be negative');
    }

    if (scheduledPrincipal.plus(scheduledInterest).lte(0)) {
      throw new UnprocessableEntityException('EMI amount must be positive');
    }

    if (paymentAmount.lt(totalDue)) {
      throw new UnprocessableEntityException(
        `Payment amount ${paymentAmount.toFixed(4)} is less than the full amount due ` +
          `${totalDue.toFixed(4)} (scheduled principal + interest + overdue penalty). ` +
          `Partial/short EMI payments are not supported — this ledger has no penalty or ` +
          `interest receivable account to carry a shortfall on.`,
      );
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected additionalSystemAccounts(): Record<string, string> {
    return { penaltyRevenue: '4020' };
  }

  protected getLimitCheckSpecs(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): { accountId: string; amount: string }[] {
    const wallet = accounts['wallet'];
    if (!wallet) return [];

    const { paymentAmount } = this.computeAmounts(payload);
    return [{ accountId: wallet.id, amount: paymentAmount.toFixed(4) }];
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const loanReceivable = this.requireAccount(accounts, 'loanReceivable');
    const interestIncome = this.requireAccount(accounts, 'interestIncome');
    const penaltyRevenue = this.requireAccount(accounts, 'penaltyRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const { daysOverdue, penalty, paymentAmount, penaltyApplied, interestApplied, principalApplied } =
      this.computeAmounts(payload);

    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const emiNumber = String(payload['emiNumber'] ?? '');
    const loanRef = String(payload['loanReference'] ?? '');

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount: paymentAmount.toFixed(4),
        currency,
        narrative:
          `EMI payment${emiNumber ? ` #${emiNumber}` : ''}${loanRef ? ` — loan:${loanRef}` : ''}` +
          (daysOverdue > 0 ? ` (${daysOverdue.toString()} days overdue)` : ''),
      },
      {
        accountId: loanReceivable.id,
        entryType: 'CREDIT' as const,
        amount: principalApplied.toFixed(4),
        currency,
        narrative: `Principal repayment`,
      },
      {
        accountId: interestIncome.id,
        entryType: 'CREDIT' as const,
        amount: interestApplied.toFixed(4),
        currency,
        narrative: `Interest income on loan`,
      },
      ...(penaltyApplied.gt(0)
        ? [
            {
              accountId: penaltyRevenue.id,
              entryType: 'CREDIT' as const,
              amount: penaltyApplied.toFixed(4),
              currency,
              narrative: `Overdue penalty — ${daysOverdue.toString()} days at ${LoanEmiPaymentHandler.PENALTY_RATE_PER_DAY.times(100).toFixed(2)}%/day (${penalty.toFixed(4)} accrued)`,
            },
          ]
        : []),
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
      metadata: {
        daysOverdue,
        penalty: penalty.toFixed(4),
        penaltyApplied: penaltyApplied.toFixed(4),
        interestApplied: interestApplied.toFixed(4),
        principalApplied: principalApplied.toFixed(4),
      },
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
