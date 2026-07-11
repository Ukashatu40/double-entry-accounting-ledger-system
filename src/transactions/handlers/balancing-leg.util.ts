// src/transactions/handlers/balancing-leg.util.ts
import Decimal from 'decimal.js';
import type { EntryType } from '@prisma/client';

export interface BalancingCandidateLine {
  entryType: EntryType;
  amount: string;
}

export interface ComputedBalancingLeg {
  entryType: EntryType;
  amount: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (see ADR-007 — Platform Operating Cash & Fee-Splitting)
 * ─────────────────────────────────────────────────────────────────────────
 * A transaction that both (a) moves value through a correctly-signed
 * Asset/Liability account (e.g. a customer wallet, following Table A1.1 —
 * Debit=Increase for Assets) AND (b) recognizes a Revenue or Expense line
 * for the same economic event can never be balanced using only those
 * "real" lines. A Revenue account's normal-balance side (Credit) is never
 * the natural double-entry counterpart of a wallet's decrease (also
 * Credit) — pairing them leaves a residual that must land somewhere.
 *
 * This is not a workaround for a bug — it is an unavoidable structural
 * fact of double-entry bookkeeping whenever a single transaction touches
 * three "roles" at once (payer, payee/counterparty, P&L recognition).
 * Real ledger systems resolve it with a dedicated clearing/suspense
 * account. This codebase already uses that pattern for FX activity
 * (see seed accounts 1043 "FX Revaluation Suspense" and 9002 "Suspense –
 * Unreconciled" — both explicitly documented as "not a real cash
 * position, purely a balancing mechanism"). Platform Operating Cash
 * (account 1050) plays the identical role for fee/expense-splitting
 * transactions.
 *
 * USAGE CONTRACT:
 * Every OTHER line in the journal must already have the economically
 * correct entryType for its own account (per Table A1.1) — this function
 * does not know or care about account semantics, it only computes
 * whatever single residual line makes SUM(debits) == SUM(credits).
 * Handlers must never derive this residual by hand (e.g. hardcoding
 * "2 × fee") — that reasoning is easy to get subtly wrong and impossible
 * to review at a glance. Compute it here, once, and test it once.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function computeBalancingLeg(
  lines: readonly BalancingCandidateLine[],
): ComputedBalancingLeg | null {
  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  for (const line of lines) {
    const amount = new Decimal(line.amount);
    if (line.entryType === 'DEBIT') {
      debitTotal = debitTotal.plus(amount);
    } else {
      creditTotal = creditTotal.plus(amount);
    }
  }

  const diff = debitTotal.minus(creditTotal);

  if (diff.isZero()) {
    return null; // Already balanced — no plug needed.
  }

  // diff > 0 means debits exceed credits, so the plug must be a CREDIT
  // (and vice versa) to bring the entry back into balance.
  return {
    entryType: diff.isPositive() ? 'CREDIT' : 'DEBIT',
    amount: diff.abs().toFixed(4),
  };
}
