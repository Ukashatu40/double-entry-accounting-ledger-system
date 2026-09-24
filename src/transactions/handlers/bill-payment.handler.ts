// src/transactions/handlers/bill-payment.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #7 — Bill Payment
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT 1001  Customer Wallet                [bill amount + convenience fee]  (Asset decrease)
 *   DEBIT  1010  Merchant Settlement – Pending  [bill amount]                    (Asset increase)
 *   CREDIT 4001  Transaction Fee Revenue         [convenience fee]                (Revenue increase)
 *   DEBIT  1050  Platform Operating Cash         [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: previously matched spec A4.2's abbreviated table
 * (DEBIT wallet / CREDIT biller), backwards on both legs per Table A1.1.
 * See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: customer wallet must have bill amount + fee available.
 *
 * Validation:
 *   - Biller account must be ACTIVE
 *   - Bill amount must be positive
 *   - Convenience fee is flat INR 5 for utility bills
 */
@Injectable()
export class BillPaymentHandler extends BaseTransactionHandler {
  private static readonly CONVENIENCE_FEE = '5.0000';
  private static readonly MAX_AMOUNT = '1000000.0000'; // INR 10 lakh

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    const biller = this.requireAccount(accounts, 'biller');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Customer wallet is not active`);
    }

    if (biller.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Biller settlement account is not active`);
    }

    requireSupportedCurrency(payload);

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    if (amount.lte(0)) {
      throw new UnprocessableEntityException('Bill amount must be positive');
    }

    if (amount.gt(new Decimal(BillPaymentHandler.MAX_AMOUNT))) {
      throw new UnprocessableEntityException(
        `Bill amount exceeds limit of ${BillPaymentHandler.MAX_AMOUNT}`,
      );
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

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const totalDebit = amount
      .plus(BillPaymentHandler.CONVENIENCE_FEE)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4);

    return [{ accountId: wallet.id, amount: totalDebit }];
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const biller = this.requireAccount(accounts, 'biller');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const billerName = String(payload['billerName'] ?? 'Utility Biller');
    const billRef = String(payload['billReference'] ?? '');
    const fee = new Decimal(BillPaymentHandler.CONVENIENCE_FEE);
    const totalDebit = amount.plus(fee).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
    const amountStr = amount.toFixed(4);

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative: `Bill payment to ${billerName}${billRef ? ` ref:${billRef}` : ''}`,
      },
      {
        accountId: biller.id,
        entryType: 'DEBIT' as const,
        amount: amountStr,
        currency,
        narrative: `Bill settlement to ${billerName}`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: fee.toFixed(4),
        currency,
        narrative: `Bill payment convenience fee`,
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
            narrative: `Bill payment — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'BILL_PAYMENT',
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
