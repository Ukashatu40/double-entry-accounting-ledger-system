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

**Spec example** shows:

- User A Wallet: CREDIT 5,010 (correct — sender pays amount + fee)
- User B Wallet: DEBIT 5,000 (correct — recipient gets amount)
- Fee Revenue: CREDIT 10 (correct — platform earns fee)

**Problem:** Entry type labels. The spec labels User A as CREDIT and User B
as DEBIT, but the debit/credit direction in the spec header row is:
`DEBIT (INR) | CREDIT (INR)` — the amounts are in the wrong columns
for User A (5,010 should be in the Credit column since the wallet
is being reduced).

**Our fix:** Implemented correct pattern: DEBIT sender wallet (reduces asset),
CREDIT recipient wallet (increases asset), CREDIT fee revenue. Total debits
(5,010) = total credits (5,000 + 10). Documented in handler comments.

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
