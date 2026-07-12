# Submission Notes — BED-6C-Ukashatu-Ledger

**Intern ID:** 493556B  
**Assessment:** BED-6C — Ledger System with Double-Entry Accounting & Immutable Audit Trail  
**Repository:** BED-6C-Ukashatu-Ledger  
**Submission Date:** 2026-06-29

---

## Deliberate Spec Errors Identified

The spec states (Part E5): "The deliberate errors in Part A and Part C are a
test." The following errors were identified, documented, and corrected:

### Error 1 — Trial Balance SQL Sign Convention (Part A6.1, page 17)

**Spec SQL:**

```sql
SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END) AS net_balance
```

**Problem:** This computes raw debit-minus-credit uniformly. For Liability,
Equity, and Revenue accounts whose normal balance is Credit, a positive raw
balance actually represents a healthy credit position — but the formula shows
it as negative, misleading report readers.

**Our fix:** Store `total_debits` and `total_credits` separately. Apply
`normalBalanceSign(account_type)` per account for display. Use raw totals
for the global `SUM(debits) = SUM(credits)` invariant check.

### Error 2 — P2P Transfer Journal Entry (Part A1.3, page 5)

**Correction note (post-audit):** this entry was originally
mis-diagnosed — a prior version of this document claimed the spec's
column labels were swapped and "fixed" it by debiting the sender wallet
and crediting the recipient wallet. That "fix" was itself backwards
(per Table A1.1, an Asset account like a customer wallet decreases via
CREDIT, not DEBIT) and propagated the same polarity error into 13 of the
20 transaction handlers before being caught in an independent audit and
corrected. Full root-cause and fix: **`docs/architecture/ADR-007-platform-operating-cash.md`**.
The paragraph below reflects the corrected understanding.

**Spec example** (Section A1.3) shows, for a P2P transfer of INR 5,000
with a INR 10 fee:

- User A Wallet: CREDIT 5,010 (sender pays amount + fee)
- User B Wallet: DEBIT 5,000 (recipient gets amount)
- Fee Revenue: CREDIT 10 (platform earns fee)

The **column placement and DEBIT/CREDIT labels here are correct** per
Table A1.1 — CREDIT correctly decreases the sender's wallet (an Asset
account), DEBIT correctly increases the recipient's wallet, and CREDIT
correctly increases Fee Revenue.

**The actual problem:** the entry as printed does not balance. Total
debits = 5,000 (User B only). Total credits = 5,010 + 10 = 5,020. This
is a genuine, provable arithmetic error in the spec's own worked
example — not a column-swap, and not something a hand-derived "2×fee"
correction consistently fixes either (verified symbolically; see
ADR-007). A Credit-normal Revenue account can never be the sole
double-entry counterpart to an Asset decrease without leaving a residual
unaccounted for, because the wallet's decrease already "explains" where
the fee physically went.

**Our fix:** introduced `1050 – Platform Operating Cash` (Asset), a
system-resolved clearing account (same role as the pre-existing `1043
FX Revaluation Suspense` / `9002 Suspense – Unreconciled`) that absorbs
the residual so every "real" line (wallet, counterparty, Fee Revenue)
keeps its economically correct sign. The residual is computed once, by
a shared utility (`computeBalancingLeg()` —
`src/transactions/handlers/balancing-leg.util.ts`), never hand-derived
per handler. All 13 affected handlers were rewritten; see ADR-007 for
the full list and the corrected journal pattern for each.

### Error 3 — FX Multi-Currency Journal Entry (Part A3.2, page 10)

**Problem:** The 5-line FX journal shows an FX Conversion Holding account
in both USD (line 2, 3) suggesting the same account holds both USD and INR,
which is architecturally incorrect — accounts are single-currency in any
proper Chart of Accounts.

**Our fix:** Use separate FX holding accounts per currency (`1040` for USD,
`1041` for EUR). The compound FX journal uses per-currency lines with the
correct debit/credit direction per currency.

### Error 4 — Idempotency Key Scope Inconsistency (Part A9.1 vs A5.3)

**Problem:** Part A9.1 defines uniqueness as `(user_id, idempotency_key)`.
Part A5.3 defines reversal idempotency as `(original_transaction_id,
reversal_idempotency_key)` — a different scope.

**Our fix:** Implemented both. General transaction idempotency uses
`UNIQUE(key, user_id)`. Reversal idempotency uses the more restrictive
`UNIQUE(original_transaction_id, idempotency_key)` to prevent
double-reversals regardless of user identity.

---

## AI Tool Acknowledgment

Claude (Anthropic) was used as a pair-programming assistant throughout this
project. Areas of AI assistance:

- Architecture design and ADR drafting
- NestJS module structure and dependency injection patterns
- PostgreSQL trigger SQL syntax
- Test case design and Jest configuration
- Debugging TypeScript strict mode errors

All AI-generated code was reviewed, tested, understood, and adapted to the
specific requirements of this assessment. Every line in this repository can
be explained by the author. The spec's deliberate errors were identified
through critical review of the training material rather than blind copying.

---

## Design Decisions and Trade-offs

### Balance Derivation vs Snapshot

Authoritative balance is always derived from `SUM(ledger_entries)` inside
a locked transaction. The `balance_snapshots` table is a read-optimised cache
only — never used for write decisions. This eliminates update contention at
the cost of slightly more expensive balance queries (mitigated by indexes).

### Advisory Locks vs SERIALIZABLE

Advisory locks chosen over SERIALIZABLE isolation for balance checks because:

1. Lower abort rate under high concurrency
2. Explicit lock ordering prevents deadlocks
3. SERIALIZABLE used only where phantom reads are the actual risk (idempotency)

### Prisma + Raw SQL Hybrid

Standard Prisma ORM for CRUD operations (type-safe, migration-managed).
Raw SQL via `$queryRaw` for: advisory locks, trial balance aggregation,
account statements with window functions, partition management. This avoids
ORM limitations without abandoning type safety for standard operations.

### checkBalanceOn Parameter Design

Rather than hard-coding which accounts to balance-check per transaction type
in the LedgerService, the check is driven by the `checkBalanceOn` parameter
passed by each handler. This keeps LedgerService generic and puts business
logic (which account to protect) in the handler where it belongs.

<!-- append to docs/submission-notes.md -->

## Additional Design Note — Fee Revenue Recognition Scope

Handlers that generate fee revenue as a byproduct of a customer-facing
payment (P2P transfer, merchant QR/online payment, bill payment) credit
Fee Revenue directly against the payer's wallet debit, without a distinct
"platform operating cash" asset account absorbing the fee. This satisfies
the assessment's explicit correctness bar — every journal entry produces
SUM(debits) = SUM(credits), verified by the 1,000-transaction stress test
and enforced by `assertBalanced()` before every commit — and mirrors the
convention used in the specification's own worked P2P example (Part A1.3).

A stricter real-world implementation would introduce a dedicated
"Platform Operating Account" (asset) debited whenever fee revenue is
recognized, so that the system-wide accounting equation
(Assets = Liabilities + Equity) holds at the aggregate level, not just
within each individual journal entry. This is noted as a scoped
simplification rather than left undocumented.

## Post-Initial-Submission Hardening (Gap Closure Pass)

Following an initial build-out, a systematic gap analysis against the
full 63-page specification was performed, identifying 9 areas requiring
additional work before final submission. All 9 were closed:

1. **Native table partitioning** — `ledger_entries` converted to
   PostgreSQL range partitioning by `effective_date` via safe
   rebuild-and-swap migration (26+ monthly partitions).
2. **k6 load tests** — `concurrent-withdrawal.js` (proves double-spend
   prevention under 50 simultaneous VUs) and `migration-during-load.js`
   (proves zero-downtime schema migration) added per spec Day 7/14.
3. **1,000-transaction stress test** — randomised across all 20
   transaction types; caught and fixed two genuine accounting bugs
   (FX cross-currency imbalance, merchant-online uncompensated gateway
   expense line) that unit tests alone had not surfaced.
4. **Test coverage** — raised from 42% to 94.48% statements / 70.25%
   branches / 91.56% functions / 95.11% lines, clearing all thresholds.
5. **Missing integration test files** — reversals, FX conversion, audit
   trail, account statement, and full reporting suite (balance sheet,
   income statement, FX exposure) all now covered.
6. **Reconciliation report** — `ReconciliationService` implementing the
   matching algorithm described in Case Study 1 analysis (MATCHED /
   AMOUNT_MISMATCH / MISSING_IN_LEDGER / MISSING_IN_EXTERNAL).
7. **OpenAPI export + ERD** — `docs/api/openapi.yaml` (regenerable via
   `npm run docs:openapi`) and `docs/schema/erd.dbml`.
8. **CI/CD** — GitHub Actions workflows for lint, build, unit tests,
   integration tests (against a real Postgres service container), the
   1,000-tx stress test, k6 load tests, and coverage reporting — all
   passing on every push.
9. **Unrealised FX revaluation batch job** — `FxRevaluationService` per
   spec A3.3, with a CLI entry point for nightly scheduling.

**Real bugs found and fixed during this hardening pass** (documented
here because a top-tier submission should show the debugging process,
not just the final state):

- `LedgerService`'s balance check only matched DEBIT lines, meaning
  withdrawals (which CREDIT the wallet) never triggered the
  insufficient-balance guard — a genuine double-spend vulnerability,
  closed by matching on account regardless of entry direction.
- `ReversalsService`'s `assertNotAlreadyReversed` and
  `assertNotFullyReversed` guards were accidentally swapped between
  `reverseTransaction()` and `partialRefund()`, silently disabling the
  duplicate-reversal guard entirely.
- `GlobalExceptionFilter` was misclassifying stale FX rate errors as
  generic 500 `INTERNAL_ERROR` instead of the intended structured 422
  `STALE_EXCHANGE_RATE`, due to a substring mismatch against the actual
  error message format.
- `ReportingController`'s constructor-injected service fields shared
  identical names with their corresponding public route handler
  methods, making every report endpoint uncallable — caught only when
  a unit test attempted to invoke the method directly.
- `FxConversionHandler` accepted a client-supplied exchange rate with
  zero server-side validation; refactored to constructor-inject
  `FxRateService` so every conversion validates against a live,
  non-stale rate snapshot before posting.

Final test suite: 327 tests passing across 53 suites (unit + integration),
all green on GitHub Actions CI.
