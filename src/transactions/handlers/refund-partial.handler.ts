// src/transactions/handlers/refund-partial.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #17 — Partial Refund
 *
 * Supports three fee refund policies (spec A5.2):
 *   PROPORTIONAL — fee refund = (refund / original) × original_fee
 *   FULL         — entire fee refunded regardless of partial amount
 *   NONE         — fee retained, customer gets only the partial amount
 *
 * Correct journal pattern (Table A1.1 + ADR-007, PROPORTIONAL example):
 *   DEBIT  1001  Customer Wallet                [partial amount + fee refund]  (Asset increase)
 *   CREDIT 1010  Merchant Settlement – Pending  [partial amount]                (Asset decrease)
 *   DEBIT  4001  Transaction Fee Revenue         [proportional fee refund]      (Revenue decrease)
 *   CREDIT 1050  Platform Operating Cash         [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: merchant and wallet legs were backwards — same
 * pattern as refund-full. See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 */
@Injectable()
export class RefundPartialHandler extends BaseTransactionHandler {
  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): Promise<void> {
    requireSupportedCurrency(payload);

    const refundAmount = parseFloat(String(payload['refundAmount'] ?? '0'));
    const originalAmount = parseFloat(String(payload['originalAmount'] ?? '0'));

    if (refundAmount <= 0) {
      throw new UnprocessableEntityException('Refund amount must be positive');
    }

    if (refundAmount > originalAmount) {
      throw new UnprocessableEntityException(
        `Refund amount ${refundAmount.toFixed(4)} exceeds original ` +
          `transaction amount ${originalAmount.toFixed(4)}`,
      );
    }

    const policy = String(payload['feePolicy'] ?? '');
    if (!['PROPORTIONAL', 'FULL', 'NONE'].includes(policy)) {
      throw new UnprocessableEntityException(
        `Invalid fee policy "${policy}" — must be PROPORTIONAL, FULL, or NONE`,
      );
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const merchantSettlement = this.requireAccount(accounts, 'merchantSettlement');
    const wallet = this.requireAccount(accounts, 'wallet');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const refundAmount = new Decimal(String(payload['refundAmount'] ?? '0'));
    const originalAmount = new Decimal(String(payload['originalAmount'] ?? '0'));
    const originalFee = new Decimal(String(payload['originalFee'] ?? '0'));
    const policy = String(payload['feePolicy'] ?? 'PROPORTIONAL');
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const originalRef = String(payload['originalTransactionId'] ?? '');
    const reason = String(payload['reason'] ?? 'Partial refund');

    let feeRefund: Decimal;
    switch (policy) {
      case 'FULL':
        feeRefund = originalFee;
        break;
      case 'NONE':
        feeRefund = new Decimal(0);
        break;
      default: // PROPORTIONAL
        feeRefund = refundAmount
          .dividedBy(originalAmount)
          .times(originalFee)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }

    const totalCredit = refundAmount.plus(feeRefund);
    const realLines: Array<{
      accountId: string;
      entryType: 'DEBIT' | 'CREDIT';
      amount: string;
      currency: string;
      narrative: string;
    }> = [
      {
        accountId: wallet.id,
        entryType: 'DEBIT',
        amount: totalCredit.toFixed(4),
        currency,
        narrative: `Partial refund credited — ${reason}`,
      },
      {
        accountId: merchantSettlement.id,
        entryType: 'CREDIT',
        amount: refundAmount.toFixed(4),
        currency,
        narrative: `Partial refund (${policy} fee policy) — ref:${originalRef}: ${reason}`,
      },
    ];

    // Only add fee reversal line if fee is actually being refunded
    if (feeRefund.gt(0)) {
      realLines.push({
        accountId: feeRevenue.id,
        entryType: 'DEBIT',
        amount: feeRefund.toFixed(4),
        currency,
        narrative: `Fee reversal — ${policy} policy on partial refund`,
      });
    }

    const plug = computeBalancingLeg(realLines);
    const lines = plug
      ? [
          ...realLines,
          {
            accountId: platformCash.id,
            entryType: plug.entryType,
            amount: plug.amount,
            currency,
            narrative: `Partial refund — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'REFUND_PARTIAL',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
