// src/transactions/handlers/merchant-payment-qr.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #5 — Merchant Payment (QR Code)
 *
 * Correct journal pattern (Table A1.1 + spec A5.1's own worked example +
 * ADR-007 — see balancing-leg.util.ts for the full derivation):
 *   CREDIT 1001  Customer Wallet                [amount + fee]  (Asset decrease)
 *   DEBIT  1010  Merchant Settlement – Pending  [amount]        (Asset increase)
 *   CREDIT 4001  Transaction Fee Revenue         [fee]          (Revenue increase)
 *   DEBIT  1050  Platform Operating Cash         [plug]
 *
 * NOTE on prior bug: this handler previously matched spec A4.2's abbreviated
 * table (DEBIT wallet / CREDIT merchant), backwards on BOTH legs relative
 * to Table A1.1 and spec A5.1's own reversal example (which explicitly
 * shows "Customer Wallet ... Credit 1,020.00" for this exact scenario).
 * See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: customer wallet must have amount + fee available.
 *
 * Additional validation:
 *   - Merchant account must be ACTIVE
 *   - Amount must be within transaction limits
 *   - Fee is calculated as 0.5% of transaction amount (min INR 1)
 */
@Injectable()
export class MerchantPaymentQrHandler extends BaseTransactionHandler {
  private static readonly FEE_RATE = 0.005; // 0.5%
  private static readonly MIN_FEE = '1.0000';
  private static readonly MAX_AMOUNT = '500000.0000';

  private calculateFee(amount: number): string {
    const fee = Math.max(
      amount * MerchantPaymentQrHandler.FEE_RATE,
      parseFloat(MerchantPaymentQrHandler.MIN_FEE),
    );
    return fee.toFixed(4);
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    const merchant = this.requireAccount(accounts, 'merchant');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Customer wallet ${wallet.code} is not active`);
    }

    if (merchant.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Merchant settlement account is not active`);
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Payment amount must be positive');
    }

    if (amount > parseFloat(MerchantPaymentQrHandler.MAX_AMOUNT)) {
      throw new UnprocessableEntityException(
        `Amount exceeds QR payment limit of ${MerchantPaymentQrHandler.MAX_AMOUNT}`,
      );
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const merchant = this.requireAccount(accounts, 'merchant');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const merchantName = String(payload['merchantName'] ?? 'Merchant');
    const qrRef = String(payload['qrReference'] ?? '');

    const fee = this.calculateFee(amount);
    const totalDebit = (amount + parseFloat(fee)).toFixed(4);
    const amountStr = amount.toFixed(4);

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative: `QR payment to ${merchantName}${qrRef ? ` ref:${qrRef}` : ''}`,
      },
      {
        accountId: merchant.id,
        entryType: 'DEBIT' as const,
        amount: amountStr,
        currency,
        narrative: `QR payment from customer — pending settlement`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: fee,
        currency,
        narrative: `QR payment fee — 0.5% of ${amountStr}`,
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
            narrative: `QR payment — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'MERCHANT_PAYMENT_QR',
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
