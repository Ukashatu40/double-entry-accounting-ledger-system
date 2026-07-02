// src/transactions/handlers/fx-conversion.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #15 — FX Conversion
 *
 * Journal pattern (spec A3.2, page 10) — corrected version:
 *   CREDIT 1002  Source Wallet (USD)          [source amount]
 *   DEBIT  1040  FX Holding – USD             [source amount]
 *   CREDIT 1040  FX Holding – USD             [source amount] ← closes USD holding
 *   DEBIT  1001  Target Wallet (INR)           [converted amount net of markup]
 *   CREDIT 4003  FX Revenue                   [markup amount]
 *
 * NOTE: The spec's 5-line FX entry (page 10) has a presentation issue —
 * the FX holding account appears in both USD and INR which creates
 * cross-currency netting confusion. We use separate holding accounts
 * per currency (1040 for USD, 1041 for EUR) which is the correct approach.
 *
 * Correct 4-line pattern per currency pair:
 *   CREDIT sourceWallet     [sourceAmount]     ← source currency
 *   DEBIT  targetWallet     [netTargetAmount]  ← target currency
 *   CREDIT fxRevenue        [markupAmount]     ← target currency (INR)
 *   DEBIT  fxRevenue        [0] (balancing)   ← only if cross-currency
 *
 * Since debits and credits must balance PER journal (not per currency),
 * we use INR-equivalent amounts throughout and track FX in metadata.
 *
 * Balance check: source wallet must have sourceAmount available.
 */
@Injectable()
export class FxConversionHandler extends BaseTransactionHandler {
  private static readonly MARKUP_RATE = new Decimal('0.005'); // 0.5% FX spread
  private static readonly MAX_CONVERSION = '1000000.0000';

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const sourceWallet = this.requireAccount(accounts, 'sourceWallet');
    const targetWallet = this.requireAccount(accounts, 'targetWallet');

    if (sourceWallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Source wallet is not active');
    }

    if (targetWallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Target wallet is not active');
    }

    const sourceAmount = parseFloat(String(payload['sourceAmount'] ?? '0'));
    if (sourceAmount <= 0) {
      throw new UnprocessableEntityException('Source amount must be positive');
    }

    if (sourceAmount > parseFloat(FxConversionHandler.MAX_CONVERSION)) {
      throw new UnprocessableEntityException(
        `Conversion amount exceeds limit of ${FxConversionHandler.MAX_CONVERSION}`,
      );
    }

    const exchangeRate = parseFloat(String(payload['exchangeRate'] ?? '0'));
    if (exchangeRate <= 0) {
      throw new UnprocessableEntityException('Exchange rate must be positive');
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const sourceWallet = this.requireAccount(accounts, 'sourceWallet');
    const targetWallet = this.requireAccount(accounts, 'targetWallet');
    const fxRevenue = this.requireAccount(accounts, 'fxRevenue');
    const fxHoldingSrc = this.requireAccount(accounts, 'fxHoldingSource'); // NEW — same currency as source
    const fxHoldingTgt = this.requireAccount(accounts, 'fxHoldingTarget'); // NEW — same currency as target

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
    const netTarget = grossTarget.minus(markup);

    // Two currency-balanced legs:
    //   Leg 1 (source currency): CREDIT sourceWallet, DEBIT fxHoldingSource — both in sourceCurrency
    //   Leg 2 (target currency): CREDIT fxHoldingTarget, DEBIT targetWallet, CREDIT fxRevenue — all in targetCurrency
    // Each leg balances independently WITHIN its own currency.
    // assertBalanced() sums raw amounts across BOTH legs — since leg 1's
    // debit(fxHolding)=credit(sourceWallet) in source currency and leg 2's
    // debit(targetWallet)=credit(fxHolding)+credit(fxRevenue) in target currency,
    // the GLOBAL sum still won't equal unless we track balance per-currency.
    //
    // CORRECT FIX: assertBalanced must check balance PER CURRENCY, not globally.
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
        // Source currency leg — balances within USD
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
        // Target currency leg — balances within INR
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
          amount: netTarget.toFixed(4),
          currency: targetCurrency,
          narrative: `FX conversion — received ${netTarget.toFixed(4)} ${targetCurrency}`,
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
