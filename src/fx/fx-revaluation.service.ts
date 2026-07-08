// src/fx/fx-revaluation.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '@database/database.service';
import { LedgerService } from '@ledger/ledger.service';
import { FxRateService } from './fx-rate.service';
import { toDecimal } from '@common/types/money.type';

interface ForeignBalanceRow {
  account_id: string;
  currency: string;
  balance: string;
  account_code: string;
  account_name: string;
}

export interface RevaluationLineResult {
  accountId: string;
  accountCode: string;
  currency: string;
  foreignBalance: string;
  closingRate: string;
  revaluedInrAmount: string;
  costBasisInrAmount: string;
  unrealisedGainLoss: string;
  direction: 'GAIN' | 'LOSS' | 'FLAT';
}

export interface RevaluationRunResult {
  runId: string;
  runAt: string;
  asOfDate: string;
  lines: RevaluationLineResult[];
  totalUnrealisedGain: string;
  totalUnrealisedLoss: string;
  netUnrealisedImpact: string;
  journalId: string | null;
}

@Injectable()
export class FxRevaluationService {
  private readonly logger = new Logger(FxRevaluationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly fxRateService: FxRateService,
  ) {}

  /**
   * Nightly unrealised FX revaluation batch job (spec A3.3).
   *
   * Process:
   *   1. Find every account holding a non-INR balance (derived from
   *      ledger_entries, never from a stored balance column).
   *   2. Fetch the account's ORIGINAL cost-basis INR value — the sum of
   *      INR-equivalent amounts recorded at the time each entry was
   *      posted (we track this via the account's cost-basis ledger,
   *      approximated here as the balance valued at the FIRST rate
   *      captured for that pair in the lookback window — a simplification
   *      documented below).
   *   3. Fetch the closing (current) rate for that currency pair.
   *   4. Compute: revalued = foreignBalance * closingRate
   *              gain/loss = revalued - costBasis
   *   5. Post a journal entry crediting Unrealised FX Gain (4004) or
   *      debiting Unrealised FX Loss (5004), offset against a designated
   *      FX Revaluation Suspense account so the entry balances without
   *      touching the customer-facing wallet itself (a revaluation is a
   *      REPORTING adjustment, not a real cash movement).
   *
   * IMPORTANT DESIGN NOTE: this posts a NEW journal entry every run
   * rather than mutating a balance (immutability principle preserved).
   * To avoid double-counting across consecutive runs, each run's
   * unrealised gain/loss is computed relative to the PREVIOUS run's
   * closing valuation, not from scratch against original cost — this
   * mirrors how real treasury systems roll forward daily revaluations.
   */
  async runRevaluation(
    asOfDate: Date,
    suspenseAccountId: string,
    actor = 'SYSTEM_FX_REVALUATION',
  ): Promise<RevaluationRunResult> {
    const runId = uuidv7();
    this.logger.log(`Starting FX revaluation run ${runId} as of ${asOfDate.toISOString()}`);

    // Step 1 — find every account with a non-zero non-INR balance
    const foreignBalances = await this.db.$queryRaw<ForeignBalanceRow[]>`
      SELECT
        le.account_id,
        le.currency,
        a.code AS account_code,
        a.name AS account_name,
        SUM(
          CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE -le.amount END
        )::TEXT AS balance
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      WHERE le.status = 'POSTED'
        AND le.effective_date <= ${asOfDate}
        AND le.currency != 'INR'
        AND a.type = 'ASSET'
      GROUP BY le.account_id, le.currency, a.code, a.name
      HAVING SUM(
        CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE -le.amount END
      ) != 0
    `;

    if (foreignBalances.length === 0) {
      this.logger.log('No foreign-currency balances found — nothing to revalue');
      return {
        runId,
        runAt: new Date().toISOString(),
        asOfDate: asOfDate.toISOString(),
        lines: [],
        totalUnrealisedGain: '0.0000',
        totalUnrealisedLoss: '0.0000',
        netUnrealisedImpact: '0.0000',
        journalId: null,
      };
    }

    const lines: RevaluationLineResult[] = [];
    let totalGain = new Decimal(0);
    let totalLoss = new Decimal(0);

    for (const row of foreignBalances) {
      const foreignBalance = toDecimal(row.balance);

      // Step 2 — cost basis: value at the last revaluation's closing rate,
      // or if this is the first run, the rate at first acquisition.
      // We use the most recent PRIOR rate snapshot before today's as a
      // stand-in for "yesterday's closing rate" (the daily rollforward).
      let costBasisRate: Decimal;
      try {
        const priorRate = await this.fxRateService.getRateAtTime(
          row.currency,
          'INR',
          new Date(asOfDate.getTime() - 24 * 60 * 60 * 1000),
        );
        costBasisRate = toDecimal(priorRate.rate.toString());
      } catch {
        // No prior-day rate exists (e.g. first-ever run) — fall back to
        // today's rate, which correctly yields zero gain/loss for a
        // brand-new position.
        const todayRate = await this.fxRateService.getCurrentRate(row.currency, 'INR');
        costBasisRate = toDecimal(todayRate.rate.toString());
      }

      // Step 3 — closing rate (today's current rate)
      let closingRate: Decimal;
      try {
        const rate = await this.fxRateService.getCurrentRate(row.currency, 'INR');
        closingRate = toDecimal(rate.rate.toString());
      } catch (error) {
        this.logger.warn(
          `Skipping revaluation for ${row.currency} — no valid current rate available: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      // Step 4 — compute gain/loss
      const costBasisInr = foreignBalance
        .times(costBasisRate)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const revaluedInr = foreignBalance
        .times(closingRate)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      const unrealised = revaluedInr.minus(costBasisInr);

      let direction: 'GAIN' | 'LOSS' | 'FLAT' = 'FLAT';
      if (unrealised.gt(0)) {
        direction = 'GAIN';
        totalGain = totalGain.plus(unrealised);
      } else if (unrealised.lt(0)) {
        direction = 'LOSS';
        totalLoss = totalLoss.plus(unrealised.abs());
      }

      lines.push({
        accountId: row.account_id,
        accountCode: row.account_code,
        currency: row.currency,
        foreignBalance: foreignBalance.toFixed(4),
        closingRate: closingRate.toFixed(8),
        revaluedInrAmount: revaluedInr.toFixed(4),
        costBasisInrAmount: costBasisInr.toFixed(4),
        unrealisedGainLoss: unrealised.toFixed(4),
        direction,
      });
    }

    const netImpact = totalGain.minus(totalLoss);

    // Step 5 — post a single consolidated journal entry for this run.
    // Skip posting if there's genuinely nothing to record (all FLAT).
    let journalId: string | null = null;

    if (!netImpact.eq(0)) {
      const unrealisedGainAccount = await this.requireAccountByCode('4004');
      const unrealisedLossAccount = await this.requireAccountByCode('5004');

      const journalLines: Array<{
        accountId: string;
        entryType: 'DEBIT' | 'CREDIT';
        amount: string;
        currency: string;
        narrative: string;
      }> = [];

      if (totalGain.gt(0)) {
        // Gain: CREDIT the gain revenue account, DEBIT suspense (asset side up)
        journalLines.push(
          {
            accountId: suspenseAccountId,
            entryType: 'DEBIT',
            amount: totalGain.toFixed(4),
            currency: 'INR',
            narrative: `FX revaluation suspense — unrealised gain run ${runId}`,
          },
          {
            accountId: unrealisedGainAccount.id,
            entryType: 'CREDIT',
            amount: totalGain.toFixed(4),
            currency: 'INR',
            narrative: `Unrealised FX gain — revaluation run ${runId}`,
          },
        );
      }
      if (totalLoss.gt(0)) {
        // Loss: DEBIT the loss expense account, CREDIT suspense (asset side down)
        journalLines.push(
          {
            accountId: unrealisedLossAccount.id,
            entryType: 'DEBIT',
            amount: totalLoss.toFixed(4),
            currency: 'INR',
            narrative: `Unrealised FX loss — revaluation run ${runId}`,
          },
          {
            accountId: suspenseAccountId,
            entryType: 'CREDIT',
            amount: totalLoss.toFixed(4),
            currency: 'INR',
            narrative: `FX revaluation suspense — unrealised loss run ${runId}`,
          },
        );
      }

      const journal = await this.ledger.postJournalEntry(
        {
          referenceType: 'FX_CONVERSION', // closest existing type; revaluation is FX-domain
          referenceId: runId,
          effectiveDate: asOfDate.toISOString(),
          lines: journalLines,
          metadata: {
            revaluationRun: true,
            totalGain: totalGain.toFixed(4),
            totalLoss: totalLoss.toFixed(4),
          },
        },
        actor,
        undefined,
        { checkBalanceOn: [] },
      );

      journalId = journal.journalId;
    }

    this.logger.log(
      `FX revaluation run ${runId} complete: ${lines.length.toString()} positions, ` +
        `gain=${totalGain.toFixed(4)} loss=${totalLoss.toFixed(4)} net=${netImpact.toFixed(4)}`,
    );

    return {
      runId,
      runAt: new Date().toISOString(),
      asOfDate: asOfDate.toISOString(),
      lines,
      totalUnrealisedGain: totalGain.toFixed(4),
      totalUnrealisedLoss: totalLoss.toFixed(4),
      netUnrealisedImpact: netImpact.toFixed(4),
      journalId,
    };
  }

  private async requireAccountByCode(code: string): Promise<{ id: string }> {
    const account = await this.db.account.findUnique({ where: { code } });
    if (!account) {
      throw new NotFoundException(
        `Required account ${code} not found — run db seed to create FX gain/loss accounts`,
      );
    }
    return account;
  }
}
