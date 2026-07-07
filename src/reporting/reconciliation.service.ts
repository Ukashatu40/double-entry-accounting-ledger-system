// src/reporting/reconciliation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DatabaseService } from '@database/database.service';
import { toDecimal } from '@common/types/money.type';
import type { ExternalStatementLineDto } from './dto/reconciliation.dto';

export type ReconciliationStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'MISSING_IN_LEDGER' // present externally, not found in our ledger
  | 'MISSING_IN_EXTERNAL'; // present in our ledger, not found externally

export interface ReconciliationLine {
  status: ReconciliationStatus;
  referenceId: string;
  ledgerAmount: string | null;
  externalAmount: string | null;
  currency: string;
  discrepancy: string | null;
  narrative: string;
}

export interface ReconciliationReport {
  fromDate: string;
  toDate: string;
  generatedAt: string;
  totalLedgerTransactions: number;
  totalExternalTransactions: number;
  matchedCount: number;
  amountMismatchCount: number;
  missingInLedgerCount: number;
  missingInExternalCount: number;
  totalDiscrepancyAmount: string;
  isFullyReconciled: boolean;
  lines: ReconciliationLine[];
}

interface LedgerReferenceRow {
  reference_id: string;
  currency: string;
  narrative: string;
  // Net amount per referenceId: for a well-formed transaction, the
  // customer-facing "total charged/received" amount is the largest
  // single DEBIT or CREDIT leg tied to that referenceId.
  amount: string;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  // Amounts within this tolerance are still considered MATCHED — protects
  // against sub-paisa rounding differences between systems, not a
  // relaxation of the ledger's own zero-tolerance internal balancing.
  private static readonly TOLERANCE = new Decimal('0.01');

  constructor(private readonly db: DatabaseService) {}

  /**
   * Reconcile internal ledger transactions against an external statement
   * (bank export, payment gateway settlement file, NPCI UPI settlement).
   *
   * Matching algorithm (spec Case Study 1 — Paytm/NPCI reconciliation):
   *   1. Group ledger entries by reference_id (the business transaction ID),
   *      taking the largest absolute amount per group as the "transaction
   *      amount" — this is always the customer-facing total (wallet debit/
   *      credit), not a fee or revenue sub-line.
   *   2. Build a lookup map of external statement lines keyed by
   *      externalReference.
   *   3. For every ledger reference_id: if a matching external line exists
   *      and amounts agree within tolerance → MATCHED. If it exists but
   *      amounts differ → AMOUNT_MISMATCH. If no external line exists →
   *      MISSING_IN_EXTERNAL (we recorded it, the external system didn't).
   *   4. For every external line with no corresponding ledger reference_id
   *      → MISSING_IN_LEDGER (the external system recorded it, we didn't —
   *      this is the more dangerous case, e.g. an unrecorded settlement).
   *
   * This is a straightforward O(n) hash-join, appropriate for daily batch
   * reconciliation volumes. For NPCI-scale (5-10M/day, per Case Study 1),
   * the same algorithm would run as a partitioned batch job reading
   * directly from a staged external file rather than an in-memory array.
   */
  async reconcile(
    from: Date,
    to: Date,
    externalStatement: ExternalStatementLineDto[],
  ): Promise<ReconciliationReport> {
    // Step 1 — pull ledger transaction totals per reference_id in range
    const ledgerRows = await this.db.$queryRaw<LedgerReferenceRow[]>`
      SELECT
        reference_id,
        currency,
        MAX(narrative)  AS narrative,
        MAX(amount)::TEXT AS amount
      FROM ledger_entries
      WHERE status = 'POSTED'
        AND effective_date >= ${from}
        AND effective_date <= ${to}
      GROUP BY reference_id, currency
    `;

    const ledgerMap = new Map<string, LedgerReferenceRow>();
    for (const row of ledgerRows) {
      ledgerMap.set(row.reference_id, row);
    }

    const externalMap = new Map<string, ExternalStatementLineDto>();
    for (const line of externalStatement) {
      externalMap.set(line.externalReference, line);
    }

    const lines: ReconciliationLine[] = [];
    let totalDiscrepancy = new Decimal(0);
    let matchedCount = 0;
    let amountMismatchCount = 0;
    let missingInLedgerCount = 0;
    let missingInExternalCount = 0;

    // Step 2 — walk every ledger reference and try to find its external match
    for (const [referenceId, ledgerRow] of ledgerMap) {
      const external = externalMap.get(referenceId);
      const ledgerAmount = toDecimal(ledgerRow.amount);

      if (!external) {
        missingInExternalCount++;
        lines.push({
          status: 'MISSING_IN_EXTERNAL',
          referenceId,
          ledgerAmount: ledgerAmount.toFixed(4),
          externalAmount: null,
          currency: ledgerRow.currency,
          discrepancy: ledgerAmount.toFixed(4),
          narrative: `Recorded in ledger (${ledgerRow.narrative}) but absent from external statement`,
        });
        totalDiscrepancy = totalDiscrepancy.plus(ledgerAmount.abs());
        continue;
      }

      const externalAmount = toDecimal(external.amount);
      const diff = ledgerAmount.minus(externalAmount).abs();

      if (diff.lte(ReconciliationService.TOLERANCE)) {
        matchedCount++;
        lines.push({
          status: 'MATCHED',
          referenceId,
          ledgerAmount: ledgerAmount.toFixed(4),
          externalAmount: externalAmount.toFixed(4),
          currency: ledgerRow.currency,
          discrepancy: '0.0000',
          narrative: ledgerRow.narrative,
        });
      } else {
        amountMismatchCount++;
        totalDiscrepancy = totalDiscrepancy.plus(diff);
        lines.push({
          status: 'AMOUNT_MISMATCH',
          referenceId,
          ledgerAmount: ledgerAmount.toFixed(4),
          externalAmount: externalAmount.toFixed(4),
          currency: ledgerRow.currency,
          discrepancy: diff.toFixed(4),
          narrative: `Ledger and external amounts disagree by ${diff.toFixed(4)}`,
        });
      }

      externalMap.delete(referenceId); // consumed — remainder are ledger-missing
    }

    // Step 3 — any external lines left unconsumed have no ledger counterpart
    for (const [referenceId, external] of externalMap) {
      missingInLedgerCount++;
      const externalAmount = toDecimal(external.amount);
      totalDiscrepancy = totalDiscrepancy.plus(externalAmount.abs());
      lines.push({
        status: 'MISSING_IN_LEDGER',
        referenceId,
        ledgerAmount: null,
        externalAmount: externalAmount.toFixed(4),
        currency: external.currency,
        discrepancy: externalAmount.toFixed(4),
        narrative:
          `Present in external statement but no matching ledger entry found — ` +
          `possible unrecorded transaction (Case Study 1 risk pattern)`,
      });
    }

    const isFullyReconciled =
      amountMismatchCount === 0 && missingInLedgerCount === 0 && missingInExternalCount === 0;

    if (!isFullyReconciled) {
      this.logger.warn(
        `Reconciliation discrepancies found: ${amountMismatchCount.toString()} mismatches, ` +
          `${missingInLedgerCount.toString()} missing-in-ledger, ` +
          `${missingInExternalCount.toString()} missing-in-external, ` +
          `total discrepancy=${totalDiscrepancy.toFixed(4)}`,
      );
    } else {
      this.logger.log(`Reconciliation clean: ${matchedCount.toString()} transactions matched`);
    }

    return {
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
      generatedAt: new Date().toISOString(),
      totalLedgerTransactions: ledgerMap.size,
      totalExternalTransactions: externalStatement.length,
      matchedCount,
      amountMismatchCount,
      missingInLedgerCount,
      missingInExternalCount,
      totalDiscrepancyAmount: totalDiscrepancy.toFixed(4),
      isFullyReconciled,
      // Sort so discrepancies surface first — most actionable for an operator
      lines: lines.sort((a, b) => {
        const order: Record<ReconciliationStatus, number> = {
          MISSING_IN_LEDGER: 0,
          AMOUNT_MISMATCH: 1,
          MISSING_IN_EXTERNAL: 2,
          MATCHED: 3,
        };
        return order[a.status] - order[b.status];
      }),
    };
  }
}
