// src/transactions/handlers/merchant-payment-online.handler.ts — full corrected file

import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { BaseTransactionHandler } from './base-transaction.handler';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #6 — Merchant Payment (Online / Payment Page)
 *
 * Journal pattern (corrected — 3-line, self-balancing):
 *   DEBIT  wallet        amount + platformFee   (customer charged)
 *   CREDIT merchant      amount - gatewayFee     (merchant net settlement)
 *   CREDIT feeRevenue    platformFee + gatewayFee (platform's total spread)
 *
 * The gateway cost is absorbed into feeRevenue's credit rather than a
 * separate unbalanced DEBIT/CREDIT pair. This keeps the journal entry
 * balanced by construction: whatever is deducted from the merchant
 * plus whatever is added to the customer's charge all lands as platform
 * revenue in a single, symmetric entry.
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

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const wallet = this.requireAccount(accounts, 'wallet');
    const merchant = this.requireAccount(accounts, 'merchant');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');

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

    return {
      referenceType: 'MERCHANT_PAYMENT_ONLINE',
      referenceId: transactionId,
      effectiveDate,
      metadata: { platformFee: platformFee.toFixed(4), gatewayFee: gatewayFee.toFixed(4) },
      lines: [
        {
          accountId: wallet.id,
          entryType: 'DEBIT',
          amount: totalDebit,
          currency,
          narrative: `Online payment to ${merchantName}${orderId ? ` order:${orderId}` : ''}`,
        },
        {
          accountId: merchant.id,
          entryType: 'CREDIT',
          amount: netToMerchant,
          currency,
          narrative: `Online payment settlement (net of gateway fee ${gatewayFee.toFixed(4)})`,
        },
        {
          accountId: feeRevenue.id,
          entryType: 'CREDIT',
          amount: totalRevenue,
          currency,
          narrative: `Online payment platform spread — fee ${platformFee.toFixed(4)} + gateway margin ${gatewayFee.toFixed(4)} on ${amountStr}`,
        },
      ],
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
