# ADR-007: Platform Operating Cash & Fee/Expense-Splitting Balance Strategy

**Status:** Accepted
**Date:** 2026-07-11
**Supersedes:** the fee-splitting journal pattern originally used in
`p2p-transfer`, `merchant-payment-qr`, `merchant-payment-online`,
`bill-payment`, `loan-emi-payment`, `fee-deduction`, `cashback-credit`,
`promotional-credit`, `interest-payout`, `chargeback`, `refund-full`,
`refund-partial`, and `reward-redemption`.

## Context

An independent audit found that 13 of the 20 transaction handlers posted the
customer wallet leg with the **wrong** `entryType` relative to Table A1.1
(Asset accounts: Debit = Increase, Credit = Decrease). Every affected handler
matched spec Section A4.2's abbreviated "Journal Pattern" column instead of
Table A1.1 and the spec's own worked examples (A1.3, A3.2, A5.1) — which are
internally consistent and correct, but contradict A4.2's shorthand. This is
exactly the trap Part E5 warns about.

Fixing the polarity in isolation, however, revealed a second, structural
problem: a transaction that both (a) moves value through a correctly-signed
wallet leg and (b) recognizes a Revenue or Expense leg for the same event
**cannot balance using only those two "real" legs.** Worked through
symbolically (and verified against the spec's own P2P and Merchant Payment
examples, both of which also fail to balance as printed):

```
CREDIT senderWallet (amount + fee)
DEBIT  recipientWallet (amount)
CREDIT feeRevenue (fee)
```

`debits = amount`, `credits = amount + 2·fee` — off by `2·fee`, not `fee`.
This is not a rounding or sign slip; a Credit-normal Revenue account can
never be the sole double-entry counterpart to an Asset decrease without
leaving a residual, because the wallet's decrease already "explains" where
the fee physically went (it left the sender) — crediting Revenue for the
same fee a second time creates value that isn't backed by any matching debit.

## Decision

Introduce **`1050 – Platform Operating Cash`** (Asset), a system-resolved
clearing account that absorbs whatever residual is needed to balance a
correctly-signed entry — the same role `1043 FX Revaluation Suspense` and
`9002 Suspense – Unreconciled` already play elsewhere in this ledger.

Two implementation rules:

1. **Handlers never hand-derive the residual amount.** `buildJournalEntry()`
   constructs only the economically real lines (correct `entryType` per
   Table A1.1), then calls `computeBalancingLeg()`
   (`src/transactions/handlers/balancing-leg.util.ts`), which computes
   `SUM(debits) − SUM(credits)` across the real lines and returns the single
   plug line needed. This removes hand-calculated constants (e.g. "2×fee")
   from handler code entirely — the arithmetic is centralized, unit-tested
   once, and impossible to get subtly wrong per-handler.
2. **Callers never supply the Platform Operating Cash account ID.** It is a
   system account, resolved automatically inside `BaseTransactionHandler.execute()`
   for any handler overriding `requiresPlatformOperatingCash() → true`. This
   avoids a breaking API/DTO change across 13 handlers and every existing
   caller/test.

## Consequences

- `1050` accumulates a running balance that is **not** a literal cash
  position (like `1043`/`9002`, its balance is a mechanical artifact of the
  balancing requirement, not something reported as "the bank's fee income").
  Reporting (Income Statement) continues to read `4001 Transaction Fee
Revenue` and equivalent Revenue/Expense accounts directly — those are
  still credited/debited correctly and carry the real economic meaning.
- Every affected handler's `buildJournalEntry()` was rewritten. Existing
  tests that asserted only `SUM(debits) == SUM(credits)` (true both before
  and after this fix, since the _old_ code was also numerically balanced,
  just with wrong signs) were insufficient to catch the original bug.
  Tests were added/strengthened to assert **directional** balance movement
  (e.g. sender balance strictly decreases, recipient balance strictly
  increases) — see `tests/unit/transaction-handlers/*.spec.ts` and the
  updated assertions in `tests/integration/reversals.spec.ts` and
  `tests/integration/trial-balance.spec.ts`.
- `1050` must be seeded before any of the 13 handlers can process a
  transaction; `requiresPlatformOperatingCash()` triggers a lookup by
  account code, which throws `NotFoundException` if the seed hasn't run —
  fails loudly rather than silently miscounting.

## Migration

Documented as `database/triggers/010_add_platform_operating_cash_account.sql`
(data migration — new account row, no schema/DDL change) — the "adding a new
account type" migration referenced in spec A7.3's list of five required
migration types.
