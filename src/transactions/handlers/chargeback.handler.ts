// src/transactions/handlers/chargeback.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #18 — Chargeback
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   CREDIT 1010  Merchant Settlement – Pending  [amount + chargeback fee]  (Asset decrease — reversed + fee)
 *   DEBIT  1001  Customer Wallet                [amount]                  (Asset increase — customer refunded)
 *   CREDIT 4030  Chargeback Fee Revenue          [chargeback fee]          (Revenue increase — already correct pre-fix)
 *   DEBIT  1050  Platform Operating Cash         [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: Merchant Settlement and the customer wallet were both
 * backwards — the merchant's pending settlement should DECREASE (they
 * lose the disputed amount and pay the fee) and the customer's wallet
 * should INCREASE (they're being refunded). See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * The merchant bears both the chargeback amount and the chargeback fee.
 * No balance check — credits the customer.
 */
@Injectable()
export class ChargebackHandler extends BaseTransactionHandler {
  private static readonly CHARGEBACK_FEE = new Decimal('500.0000'); // INR 500 flat

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): Promise<void> {
    const amount = parseFloat(String(payload['amount'] ?? '0'));
    if (amount <= 0) {
      throw new UnprocessableEntityException('Chargeback amount must be positive');
    }

    const disputeCode = String(payload['disputeCode'] ?? '');
    if (!disputeCode) {
      throw new UnprocessableEntityException('disputeCode is required for chargeback processing');
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
    const chargebackFeeRevenue = this.requireAccount(accounts, 'chargebackFeeRevenue');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const disputeCode = String(payload['disputeCode'] ?? '');
    const arn = String(payload['arn'] ?? '');

    const chargebackFee = ChargebackHandler.CHARGEBACK_FEE;
    const totalMerchantDebit = amount.plus(chargebackFee);

    const realLines = [
      {
        accountId: merchantSettlement.id,
        entryType: 'CREDIT' as const,
        amount: totalMerchantDebit.toFixed(4),
        currency,
        narrative: `Chargeback — code:${disputeCode}${arn ? ` ARN:${arn}` : ''}`,
      },
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount: amount.toFixed(4),
        currency,
        narrative: `Chargeback credited to customer — code:${disputeCode}`,
      },
      {
        accountId: chargebackFeeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: chargebackFee.toFixed(4),
        currency,
        narrative: `Chargeback fee charged to merchant`,
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
            narrative: `Chargeback — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'CHARGEBACK',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
