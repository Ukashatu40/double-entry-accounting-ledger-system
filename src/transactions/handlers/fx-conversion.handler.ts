// src/transactions/handlers/fx-conversion.handler.ts
// Add constructor injection:

import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { FxRateService } from '@fx/fx-rate.service';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

@Injectable()
export class FxConversionHandler extends BaseTransactionHandler {
  private static readonly MARKUP_RATE = new Decimal('0.005');
  private static readonly MAX_CONVERSION = '1000000.0000';

  constructor(private readonly fxRateService: FxRateService) {
    super();
  }

  protected async validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const sourceWallet = this.requireAccount(accounts, 'sourceWallet');
    const targetWallet = this.requireAccount(accounts, 'targetWallet');

    if (sourceWallet.status !== 'ACTIVE')
      throw new UnprocessableEntityException('Source wallet is not active');
    if (targetWallet.status !== 'ACTIVE')
      throw new UnprocessableEntityException('Target wallet is not active');

    const sourceAmount = parseFloat(String(payload['sourceAmount'] ?? '0'));
    if (sourceAmount <= 0) throw new UnprocessableEntityException('Source amount must be positive');
    if (sourceAmount > parseFloat(FxConversionHandler.MAX_CONVERSION)) {
      throw new UnprocessableEntityException(
        `Conversion amount exceeds limit of ${FxConversionHandler.MAX_CONVERSION}`,
      );
    }

    // CRITICAL: validate against the live rate snapshot rather than
    // trusting a client-supplied exchangeRate. This enforces staleness
    // rejection (Incident Day 6) at the point of transaction, not just
    // when previewing via GET /fx/convert.
    const sourceCurrency = String(payload['sourceCurrency'] ?? 'USD');
    const targetCurrency = String(payload['targetCurrency'] ?? 'INR');
    // Throws UnprocessableEntityException if stale or missing — propagates naturally
    await this.fxRateService.getCurrentRate(sourceCurrency, targetCurrency);
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    // ... unchanged from before ...
    const sourceWallet = this.requireAccount(accounts, 'sourceWallet');
    const targetWallet = this.requireAccount(accounts, 'targetWallet');
    const fxRevenue = this.requireAccount(accounts, 'fxRevenue');
    const fxHoldingSrc = this.requireAccount(accounts, 'fxHoldingSource');
    const fxHoldingTgt = this.requireAccount(accounts, 'fxHoldingTarget');

    const sourceAmount = new Decimal(String(payload['sourceAmount'] ?? '0'));
    const exchangeRate = new Decimal(String(payload['exchangeRate'] ?? '0'));
    const sourceCurrency = String(payload['sourceCurrency'] ?? 'USD');
    const targetCurrency = String(payload['targetCurrency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const rateSnapshotId = String(payload['rateSnapshotId'] ?? '');

    const grossTarget = sourceAmount.times(exchangeRate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const markup = grossTarget
      .times(FxConversionHandler.MARKUP_RATE)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    return {
      referenceType: 'FX_CONVERSION',
      referenceId: transactionId,
      effectiveDate,
      metadata: {
        sourceCurrency,
        targetCurrency,
        exchangeRate: exchangeRate.toFixed(8),
        grossTarget: grossTarget.toFixed(4),
        markup: markup.toFixed(4),
        rateSnapshotId,
      },
      lines: [
        {
          accountId: sourceWallet.id,
          entryType: 'CREDIT',
          amount: sourceAmount.toFixed(4),
          currency: sourceCurrency,
          narrative: `FX conversion — sold ${sourceAmount.toFixed(4)} ${sourceCurrency}`,
        },
        {
          accountId: fxHoldingSrc.id,
          entryType: 'DEBIT',
          amount: sourceAmount.toFixed(4),
          currency: sourceCurrency,
          narrative: `FX holding — received ${sourceCurrency}`,
        },
        {
          accountId: fxHoldingTgt.id,
          entryType: 'CREDIT',
          amount: grossTarget.toFixed(4),
          currency: targetCurrency,
          narrative: `FX holding — released ${targetCurrency} at rate ${exchangeRate.toFixed(8)}`,
        },
        {
          accountId: targetWallet.id,
          entryType: 'DEBIT',
          amount: grossTarget.minus(markup).toFixed(4),
          currency: targetCurrency,
          narrative: `FX conversion — received ${grossTarget.minus(markup).toFixed(4)} ${targetCurrency}`,
        },
        {
          accountId: fxRevenue.id,
          entryType: 'DEBIT',
          amount: markup.toFixed(4),
          currency: targetCurrency,
          narrative: `FX spread revenue — 0.5% markup`,
        },
      ],
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): string[] {
    const source = accounts['sourceWallet'];
    return source ? [source.id] : [];
  }
}
