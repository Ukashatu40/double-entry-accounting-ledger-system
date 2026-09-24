// src/transactions/handlers/interest-payout.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #9 — Interest Payout (Monthly)
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   DEBIT  2010  Interest Payable – Savings  [gross interest]   (Liability decrease — already correct pre-fix)
 *   DEBIT  1001  Customer Wallet             [net interest]     (Asset increase — customer receives money)
 *   CREDIT 2020  TCS / TDS Payable           [TDS amount]       (Liability increase — already correct pre-fix)
 *   CREDIT 1050  Platform Operating Cash     [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: Interest Payable and TDS Payable were already
 * correctly signed. Only the wallet leg was backwards (previously
 * CREDITed, decreasing the customer's balance, when they are actually
 * *receiving* the net interest payout). See
 * docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * TDS rate: 10% under Section 194A of IT Act (interest > INR 40,000/year).
 * For simplicity we apply 10% TDS on all payouts — handlers can be
 * extended with threshold logic in production.
 *
 * No balance check — reduces a liability and increases an asset.
 */
@Injectable()
export class InterestPayoutHandler extends BaseTransactionHandler {
  private static readonly TDS_RATE = new Decimal('0.10');

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    _accounts: Record<string, Account>,
  ): Promise<void> {
    requireSupportedCurrency(payload);

    const grossInterest = parseFloat(String(payload['grossInterest'] ?? '0'));
    if (grossInterest <= 0) {
      throw new UnprocessableEntityException('Gross interest amount must be positive');
    }
    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const interestPayable = this.requireAccount(accounts, 'interestPayable');
    const wallet = this.requireAccount(accounts, 'wallet');
    const tdsPayable = this.requireAccount(accounts, 'tdsPayable');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const gross = new Decimal(String(payload['grossInterest'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const period = String(payload['period'] ?? '');

    const tds = gross
      .times(InterestPayoutHandler.TDS_RATE)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const net = gross.minus(tds);

    const realLines = [
      {
        accountId: interestPayable.id,
        entryType: 'DEBIT' as const,
        amount: gross.toFixed(4),
        currency,
        narrative: `Monthly interest payout${period ? ` for ${period}` : ''}`,
      },
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount: net.toFixed(4),
        currency,
        narrative: `Interest credited net of TDS (10%)`,
      },
      {
        accountId: tdsPayable.id,
        entryType: 'CREDIT' as const,
        amount: tds.toFixed(4),
        currency,
        narrative: `TDS deducted u/s 194A — 10% of ${gross.toFixed(4)}`,
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
            narrative: `Interest payout — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'INTEREST_PAYOUT',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
