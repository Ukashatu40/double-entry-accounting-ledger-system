// src/transactions/handlers/refund-full.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #16 — Full Refund
 *
 * No-mutation principle (spec A5.1): we never modify the original entry.
 * A full reversal creates an exact mirror of the original journal entry —
 * every DEBIT becomes a CREDIT and every CREDIT becomes a DEBIT, for the
 * same amounts. Given the (corrected) merchant-payment origination entry:
 *   CREDIT wallet (amount+fee) / DEBIT merchant (amount) / CREDIT feeRevenue (fee)
 * the mirror is:
 *   DEBIT  1001  Customer Wallet                [amount + fee]  (Asset increase — refunded)
 *   CREDIT 1010  Merchant Settlement – Pending  [amount]        (Asset decrease — settlement reversed)
 *   DEBIT  4001  Transaction Fee Revenue         [fee]          (Revenue decrease — fee reversed)
 *   CREDIT 1050  Platform Operating Cash         [plug — mirrors origination's plug]
 *
 * NOTE on prior bug: merchant and wallet legs were backwards (matching the
 * original merchant-payment-qr bug's mirror image) — see
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * No balance check — this credits the customer wallet.
 */
@Injectable()
export class RefundFullHandler extends BaseTransactionHandler {
  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const merchantSettlement = this.requireAccount(accounts, 'merchantSettlement');
    const wallet = this.requireAccount(accounts, 'wallet');

    if (wallet.status === 'CLOSED') {
      throw new UnprocessableEntityException('Cannot refund to a closed wallet');
    }

    if (merchantSettlement.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Merchant settlement account is not active');
    }

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    if (amount.lte(0)) {
      throw new UnprocessableEntityException('Refund amount must be positive');
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

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const fee = new Decimal(String(payload['feeAmount'] ?? '0.0000'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const originalRef = String(payload['originalTransactionId'] ?? '');
    const reason = String(payload['reason'] ?? 'Customer refund');

    const totalRefund = amount.plus(fee).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount: totalRefund,
        currency,
        narrative: `Full refund credited — ${reason}`,
      },
      {
        accountId: merchantSettlement.id,
        entryType: 'CREDIT' as const,
        amount: amount.toFixed(4),
        currency,
        narrative: `Full refund — reversal of ${originalRef}: ${reason}`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'DEBIT' as const,
        amount: fee.toFixed(4),
        currency,
        narrative: `Fee reversal on full refund of ${originalRef}`,
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
            narrative: `Full refund — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'REFUND_FULL',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
