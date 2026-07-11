// src/transactions/handlers/merchant-payment-online.handler.ts — full corrected file

import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #6 — Merchant Payment (Online / Payment Page)
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT wallet               amount + platformFee    (Asset decrease — customer charged)
 *   DEBIT  merchant              amount - gatewayFee      (Asset increase — merchant settlement)
 *   CREDIT feeRevenue            platformFee + gatewayFee (Revenue increase — platform spread)
 *   DEBIT  platformOperatingCash [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: the previous version DEBITed wallet / CREDITed
 * merchant (backwards on both legs per Table A1.1) and happened to balance
 * on its own only because the gatewayFee canceled out arithmetically
 * across the wrong-signed lines — it was never checking real economic
 * direction. See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: customer wallet must have amount + platformFee available.
 */
@Injectable()
export class MerchantPaymentOnlineHandler extends BaseTransactionHandler {
  private static readonly PLATFORM_FEE_RATE = 0.005;
  private static readonly GATEWAY_FEE_RATE = 0.002;
  private static readonly MIN_FEE = '1.0000';
  private static readonly MAX_AMOUNT = '500000.0000';

  private calculatePlatformFee(amount: number): string {
    return Math.max(
      amount * MerchantPaymentOnlineHandler.PLATFORM_FEE_RATE,
      parseFloat(MerchantPaymentOnlineHandler.MIN_FEE),
    ).toFixed(4);
  }

  private calculateGatewayFee(amount: number): string {
    return Math.max(
      amount * MerchantPaymentOnlineHandler.GATEWAY_FEE_RATE,
      parseFloat(MerchantPaymentOnlineHandler.MIN_FEE),
    ).toFixed(4);
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');
    const merchant = this.requireAccount(accounts, 'merchant');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Customer wallet is not active`);
    }
    if (merchant.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Merchant settlement account is not active`);
    }

    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Payment amount must be positive');
    }
    if (amount > parseFloat(MerchantPaymentOnlineHandler.MAX_AMOUNT)) {
      throw new UnprocessableEntityException(
        `Amount exceeds online payment limit of ${MerchantPaymentOnlineHandler.MAX_AMOUNT}`,
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
    const merchantName = String(payload['merchantName'] ?? 'Online Merchant');
    const orderId = String(payload['orderId'] ?? '');

    const platformFee = parseFloat(this.calculatePlatformFee(amount));
    const gatewayFee = parseFloat(this.calculateGatewayFee(amount));

    const totalDebit = (amount + platformFee).toFixed(4);
    const netToMerchant = (amount - gatewayFee).toFixed(4);
    const totalRevenue = (platformFee + gatewayFee).toFixed(4);
    const amountStr = amount.toFixed(4);

    const realLines = [
      {
        accountId: wallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative: `Online payment to ${merchantName}${orderId ? ` order:${orderId}` : ''}`,
      },
      {
        accountId: merchant.id,
        entryType: 'DEBIT' as const,
        amount: netToMerchant,
        currency,
        narrative: `Online payment settlement (net of gateway fee ${gatewayFee.toFixed(4)})`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: totalRevenue,
        currency,
        narrative: `Online payment platform spread — fee ${platformFee.toFixed(4)} + gateway margin ${gatewayFee.toFixed(4)} on ${amountStr}`,
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
            narrative: `Online payment — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'MERCHANT_PAYMENT_ONLINE',
      referenceId: transactionId,
      effectiveDate,
      metadata: { platformFee: platformFee.toFixed(4), gatewayFee: gatewayFee.toFixed(4) },
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
