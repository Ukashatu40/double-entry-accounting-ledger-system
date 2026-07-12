# Case Study Analysis

Answers to the analysis questions in spec Part C, Case Studies 1–5. Each
answer references the actual mechanisms in this codebase rather than
describing hypothetical designs, with file references where relevant.

---

## Case Study 1: Paytm Payments Bank Ledger Reconciliation Crisis (2023–2024)

### What schema design choices could have prevented reconciliation delays at 10 million transactions/day? Discuss partitioning, indexing, and batch processing strategies.

Three things compound at that volume: unindexed date-range scans, a
monolithic table that can't be pruned or archived incrementally, and
synchronous end-of-day batch jobs that block on the full table.

- **Partitioning** (`database/triggers/008_partition_ledger_entries.sql`):
  `ledger_entries` is natively range-partitioned by `effective_date` into
  monthly child tables. A day-close job scanning "today's" entries hits
  exactly one (or two, at a month boundary) small partition instead of
  scanning the full history — partition pruning turns an O(total rows)
  scan into O(one month's rows). This is what makes daily reconciliation
  at 10M/day tractable instead of degrading linearly with total account
  age.
- **Indexing**: `idx_le_account_date (account_id, effective_date)` is the
  primary access-pattern index (account statements, balance derivation).
  Separate indexes on `reference_type`, `status`, and `currency` support
  the reconciliation and reporting queries without forcing a sequential
  scan for any of them. Critically, none of these are unique constraints
  across partitions except where explicitly needed — unique constraints
  spanning partitions require the partition key in the constraint, which
  is why idempotency is enforced at the application layer via a dedicated
  `idempotency_keys` table rather than a cross-partition unique index (see
  `008_partition_ledger_entries.sql`'s comment on this exact trade-off).
- **Batch processing**: `TrialBalanceService.generate()` and the FX
  revaluation batch (`scripts/run-fx-revaluation.ts`) both operate against
  a specific `as_of_date` window, which — combined with partition pruning
  — means a nightly close job's cost is bounded by that day's volume, not
  total ledger size. At Paytm's reported scale, an unpartitioned table
  with uncapped growth is exactly the failure mode a partitioned,
  indexed-for-access-pattern schema avoids.

### How would you design a system that automatically detects trial balance discrepancies within minutes of end-of-day cut-off, rather than days?

`TrialBalanceService.generate()` computes `SUM(debits) - SUM(credits)` per
account directly from `ledger_entries` and exposes `isBalanced` /
`discrepancy` on every call (`GET /api/v1/trial-balance`) — this already
answers "are we balanced right now" in the time it takes to run one
aggregate query, not days. To make that a genuinely _automatic_,
minutes-after-cutoff detection rather than an on-demand check:

1. Schedule `TrialBalanceService.generate()` immediately after the
   day's last partition closes (cron, right after cutoff).
2. If `discrepancy !== '0.0000'`, page immediately rather than waiting for
   a human to run the report — the query itself is cheap (bounded by one
   partition thanks to the design above), so there's no reason to delay.
3. Layer the hash-chain verification (`AuditService.verifyChain()`,
   `GET /api/v1/audit/verify`) on the same schedule — a broken chain link
   is a stronger, earlier signal than a trial balance discrepancy, since
   it can catch a _tampering_ event even in a period where debits still
   happen to sum to credits in aggregate.
4. Root-cause narrowing: because reconciliation is partition-scoped,
   discrepancy detection can immediately narrow to "which day/partition,"
   not "somewhere in years of history" — collapsing the 3–5 day
   Paytm-reported delay to the runtime of one partition-scoped aggregate.

### Propose a journal entry standardisation framework that ensures consistent entry patterns across different product teams. How would you enforce this in code?

This is exactly the class of bug an internal audit of this codebase found
and fixed (see `docs/architecture/ADR-007-platform-operating-cash.md`):
13 of 20 transaction handlers had inconsistent debit/credit polarity
because each was hand-written against an ambiguous summary table instead
of a single source of truth. The fix generalizes into a framework:

1. **One shared arithmetic primitive, not per-handler math.**
   `computeBalancingLeg()` (`src/transactions/handlers/balancing-leg.util.ts`)
   is the _only_ place residual-balancing amounts are computed. No handler
   is allowed to hand-derive a plug amount — this is exactly the kind of
   "different product teams, inconsistent entry patterns" risk the case
   study describes, and centralizing the arithmetic removes the
   opportunity for drift.
2. **A single abstract contract every handler must satisfy**
   (`BaseTransactionHandler` — `validateBusinessRules()` +
   `buildJournalEntry()` + `getBalanceCheckAccounts()`), so "new product
   team adds a transaction type" means implementing three well-defined
   methods against one interface, not inventing a new pattern.
3. **`LedgerService.postJournalEntry()` enforces `SUM(debits) ==
SUM(credits)` before any commit** (`assertBalanced()`), independent of
   which handler produced the lines — a structural guardrail that catches
   _magnitude_ mismatches regardless of which team wrote the code.
4. **What structural balance alone can't catch — and how this codebase
   closes that gap**: an entry can be numerically balanced while
   individual account legs move in the economically wrong direction (this
   is precisely what went undetected here originally). The fix was adding
   _directional_ assertions — `assertAssetAccountMoves()` /
   `assertCreditNormalAccountMoves()`
   (`tests/unit/transaction-handlers/journal-entry-assertions.util.ts`) —
   to every handler's test suite, so a reviewer or CI run catches a wrong
   entryType even when the trial balance would still pass.

### Design a reconciliation engine that compares your internal ledger against NPCI UPI settlement files. What matching algorithm would you use?

`POST /api/v1/reports/reconciliation` (`ReconciliationService`) implements
this shape already for the bank-statement/gateway-settlement case
described in spec A6.3; the same design generalizes directly to NPCI UPI
files:

1. **Deterministic key matching first.** Match internal `ledger_entries`
   rows to external settlement file rows on
   `(reference_type, reference_id)` or, where NPCI's own UTR/RRN is
   captured in `metadata` (JSONB), on that reference — O(n) via a hash
   join, not an O(n²) fuzzy match. This should account for the vast
   majority of records.
2. **Amount + date-window matching for the residual.** For rows that
   don't key-match (e.g. a UPI RRN wasn't captured at origination), fall
   back to matching on `(account_id, amount, currency)` within a narrow
   `effective_date` window — narrow because `idx_le_account_date` makes
   that range scan cheap, and narrow specifically to bound false-positive
   matches.
3. **Three-way classification, not binary pass/fail**: (a) matched —
   present and equal on both sides; (b) internal-only — an entry with no
   NPCI settlement counterpart (investigate: failed settlement, or a
   miscategorized internal transfer); (c) external-only — an NPCI
   settlement with no internal ledger entry (investigate: a transaction
   the platform never recorded — the more dangerous class, since it means
   real money moved with no audit trail). `ReconciliationService` already
   returns this three-way breakdown rather than a single boolean.
4. **Idempotent, replayable runs**: because reconciliation reads rather
   than mutates `ledger_entries`, the same NPCI file can be re-run against
   the same window without side effects — important operationally, since
   settlement files themselves sometimes arrive late or get corrected.

---

## Case Study 2: Revolut's Multi-Currency Rounding Incident (2019)

### Demonstrate with a concrete example how IEEE 754 floating-point fails for the JPY-to-KWD conversion. Show the expected vs. actual result for a specific conversion amount.

JPY and KWD sit at opposite extremes of typical unit value (JPY ~150/USD,
KWD ~0.3/USD — roughly a 500:1 ratio), which maximizes the exponent
range IEEE 754 double-precision has to span for a single multiplication,
and that's exactly where representable-value gaps show up.

Concrete example: convert JPY 1,000,000 to KWD at a rate of
`1 JPY = 0.00245 KWD`.

```js
// IEEE 754 double-precision (what plain JS/most languages' native float does)
> 1000000 * 0.00245
2450.0000000000005   // expected exactly 2450
```

The error here (5e-13) looks negligible in isolation. Revolut's own
incident is the proof this isn't a "small enough to ignore" problem: at
~2 million daily conversions, IEEE 754's _systematic_ rounding bias
(errors don't cancel out symmetrically — floating-point representation
error correlates with the specific bit patterns of common rates)
accumulated to ~GBP 12,000/day sitting in the FX holding account with no
matching revenue explanation.

### Design a multi-currency arithmetic module for your ledger that eliminates rounding errors. What data type(s) would you use, and at what precision?

This codebase never performs money arithmetic in native floating-point.
Two layers:

1. **Storage**: `amount NUMERIC(19,4)` in Postgres for every ledger line
   (`prisma/schema.prisma`) — fixed-point decimal at the database level,
   not `FLOAT`/`DOUBLE`, so no representation error is possible once a
   value is persisted. Exchange rates themselves are `NUMERIC(18,8)`
   (`exchange_rate_snapshots`), giving 8 decimal places of rate precision
   before the resulting amount is rounded to the 4-decimal money
   precision.
2. **Application-layer arithmetic**: `decimal.js` (arbitrary-precision
   decimal, not IEEE 754 binary floating point) for every intermediate
   calculation — fee splits, EMI amortization, FX conversion, the
   `computeBalancingLeg()` residual math. `ADR-001-tech-stack.md` names
   this choice explicitly as a defense against the Revolut failure mode.
   Rounding only happens once, at the final step of a calculation
   (`.toDecimalPlaces(4, Decimal.ROUND_HALF_UP)`), not accumulated across
   several native-float intermediate steps the way the incident describes.

### How would your system detect FX holding account discrepancies automatically? What threshold would trigger an alert?

The FX holding accounts (`1041`/`1042` — see chart of accounts) are
Asset-typed accounts that should, in steady state, only ever hold
transient balances mid-conversion; any _persistent_ non-zero balance is
itself the anomaly signal. Concretely:

1. Run `TrialBalanceService.generate()` scoped to the FX holding accounts
   specifically (not just the global trial balance) as part of the
   nightly close, alongside the existing FX revaluation batch
   (`scripts/run-fx-revaluation.ts`).
2. **Threshold**: alert if the FX holding balance exceeds a small
   materiality band (e.g. the equivalent of one unrounded conversion's
   worth of residual — a few paise per open conversion, times open
   conversion count) rather than a fixed absolute number, since the
   "should be near zero" band scales with transaction volume.
3. Because storage is already `NUMERIC(19,4)` decimal (not float), any
   discrepancy detected this way is a _real_ accounting or logic error —
   not, as in Revolut's case, floating-point noise masquerading as one.
   That distinction matters operationally: it means every alert is
   actionable rather than something to be dismissed as "probably just
   rounding."

### Propose a "rounding reconciliation entry" mechanism that allocates sub-unit differences to a designated rounding account at end-of-day.

Because this system already never produces sub-unit float error (decimal
arithmetic throughout, rounded once via `ROUND_HALF_UP` at calculation
time), the "rounding reconciliation entry" pattern that Revolut needed to
retrofit is closer to a defensive backstop here than a primary fix — but
it's still good practice for the cases where legitimate rounding (not
float error) produces an unallocated sub-unit remainder, e.g. splitting a
fee proportionally across parties where the split doesn't divide evenly:

1. Introduce a `9003 Rounding Adjustment` account (Expense or
   Contra-Revenue, following the `9002 Suspense – Unreconciled` pattern
   already established for exactly this kind of mechanical clearing role
   — see `docs/architecture/ADR-007-platform-operating-cash.md` for the
   precedent).
2. At end-of-day, for any calculation whose components don't sum exactly
   to the total due to legitimate independent rounding (not a bug), post
   the residual (bounded to sub-paisa magnitude, e.g. < 0.0001) to
   `9003`, with a narrative referencing the originating calculation.
3. Alert if `9003`'s daily net movement exceeds a small multiple of
   (transaction count × one unit of minimum precision) — a magnitude
   _far_ smaller than the FX holding account's alert threshold above,
   since this account should only ever accumulate genuine sub-unit
   remainders, not systemic errors.

---

## Case Study 3: The Wirecard Missing €1.9 Billion Audit Trail Failure (2020)

### How does cryptographic hash chaining in your ledger design prevent the type of entry backdating that occurred at Wirecard?

Every `ledger_entries` row stores `hash` (SHA-256 of its own data +
`previous_hash`) and `previous_hash` (the immediately preceding entry's
hash), forming a chain (`HashChainService` —
`src/audit/hash-chain.service.ts`). Backdating an entry — inserting or
altering a record to appear as though it existed, or existed with
different values, at an earlier point — breaks the chain in one of two
unavoidable ways:

- **Altering an existing entry** changes its hash, which no longer
  matches what the _next_ entry's `previous_hash` recorded — the break is
  detectable at the exact point of tampering
  (`HashChainService.verifyChain()`, unit-tested in
  `tests/unit/hash-chain.service.spec.ts` for exactly this: corrupting an
  amount or narrative and confirming the break is reported at the correct
  entry).
- **Inserting a "backdated" entry after the fact** — even with a fabricated
  `previous_hash` pointing to where it "should" have been chronologically
  — breaks the chain at the _next real_ entry, because that real entry's
  `previous_hash` was computed against the entry that actually preceded
  it at write time, not the newly inserted one.

This is reinforced, not replaced, by the `BEFORE UPDATE`/`BEFORE DELETE`
triggers (`003_immutability_triggers.sql`) that reject mutation of posted
entries outright — Wirecard's investigators specifically found evidence
that journal entries _had been_ modified after the fact, which this
system prevents at the database layer before hash verification is even
needed as a second line of defense.

### Design an external reconciliation interface that independently verifies large-balance entries against third-party confirmations. How would you prevent forged confirmations from entering the system?

Wirecard's failure wasn't a missing reconciliation process — EY _did_
rely on third-party confirmations — it was that those confirmations were
forged and accepted without independent verification of the _source_.
The design principle that follows: a confirmation is only as trustworthy
as the channel it arrived through, so the system must distinguish
"confirmation the counterparty sent us" from "confirmation someone typed
into our system claiming to be from the counterparty."

1. `ReconciliationService` (`POST /api/v1/reports/reconciliation`,
   spec A6.3) already models this as comparing internal ledger balances
   against _externally supplied_ data — the key design decision is that
   this external data must be fetched or received through an
   out-of-band, non-human-editable channel (a bank's SFTP settlement
   file, an API pull directly from the custodian) rather than accepted as
   free-text input from an internal user, which is exactly the trust
   boundary Wirecard's process failed to enforce.
2. Large-balance entries specifically (above a materiality threshold)
   should require the reconciliation match to be **cryptographically or
   structurally tied to the source** — e.g. a checksum/reference from the
   custodian's own file, not a manually-entered confirmation number —
   before the internal ledger balance for that account is treated as
   verified in reporting.
3. Any reconciliation mismatch on a large-balance account should be a
   blocking condition for that account's inclusion in a "verified" balance
   sheet, not a background exception queue that can be starved of
   attention for years, which is effectively what happened at Wirecard.

### Propose an anomaly detection system that flags unusual patterns in journal entries (e.g., large round-number entries to unfamiliar accounts, entries posted after hours, entries by users who typically don't access those accounts).

Every `ledger_entries` row already carries the metadata needed for this:
`created_by`, `posted_at` (`TIMESTAMPTZ`), `amount`, `account_id`, and
`metadata` (JSONB, extensible for IP/device — spec A2.3). A detection
layer built on top of `AuditService` would run as a scheduled query
(same cadence as trial balance / hash-chain verification) checking:

1. **Round-number bias**: entries where `amount % 1000 = 0` (or similar)
   occur at a rate statistically inconsistent with the account's normal
   transaction distribution — genuine customer transactions are rarely
   perfectly round; large round numbers concentrated in a short window
   are a classic manual-fabrication signature.
2. **Off-hours posting**: `posted_at` outside the account's/actor's
   normal operating window (comparing against a rolling historical
   baseline per `created_by`, not a single hardcoded business-hours rule,
   since some legitimate batch jobs — like the FX revaluation batch —
   genuinely run overnight and shouldn't false-positive).
3. **Unfamiliar account access**: `created_by` posting to an `account_id`
   they have no prior posting history against, especially for accounts
   above a balance materiality threshold — a first-time actor touching a
   large-balance account is exactly the "entries by users who typically
   don't access those accounts" pattern the question describes, and
   exactly the kind of internal-control gap that let Wirecard's
   fabricated entries go unquestioned for years.
4. Findings should route to the **incident-response documentation
   pattern** already established in this repo
   (`docs/incident-responses/`) — every flagged anomaly gets a
   post-mortem artifact, not a silent log line.

### How would your system handle regulatory requests for a complete, tamper-evident export of all ledger entries for a given period?

1. `GET /api/v1/audit/verify?from_date=...&to_date=...` already returns
   hash-chain verification results for a date range — the regulator gets
   both the raw data _and_ cryptographic proof it hasn't been altered
   since posting, addressing exactly the evidentiary gap Wirecard exposed
   (fabricated confirmations with no independently verifiable trail).
2. Export format: the full `ledger_entries` row set for the period,
   including `hash`/`previous_hash`, in a structured, machine-verifiable
   format (JSON or CSV with an accompanying manifest hash of the whole
   export) — so a third party can independently re-run the chain
   verification algorithm against the export itself, not just trust this
   system's own attestation.
3. Because entries are immutable and partitioned by `effective_date`, a
   date-bounded export is a well-defined, repeatable operation (query one
   or a few partitions) rather than a bespoke extraction each time —
   important for regulatory response-time requirements.
4. The export itself should be logged as an audit event
   (`AuditModule`) — who requested it, when, for what range — so the act
   of producing evidence is itself part of the evidence trail.

---

## Case Study 4: The Razorpay Concurrent Refund Vulnerability (Hypothetical)

### Reproduce this race condition in a test. Write a concurrent test that demonstrates the vulnerability without your concurrency controls, and then demonstrate that your controls prevent it.

`tests/integration/reversals.spec.ts` (`concurrentRefund` test) and
`tests/integration/concurrency.spec.ts` cover exactly this class of race:
firing multiple concurrent requests against the _same_ resource (an
account's balance, or in the refund case, the same original transaction)
using real `Promise.all()` concurrency against a live database — not
mocked or sequential — and asserting only the correct subset succeeds.
For the refund-specific case:

- `ReversalsService`'s cumulative-refund guard (reserve the intended
  refund amount, then check against the already-reserved + already-posted
  total, inside the same DB transaction) is exercised by firing two
  concurrent `reverseTransaction()` calls for the same
  `originalTransactionId` and asserting exactly one succeeds while the
  second is rejected with a clear "already reversed" / "would exceed
  original amount" error — not two partial refunds silently summing to
  double the original payment.
- The vulnerability _without_ the guard is demonstrated by contrast in
  the test's own structure: the check-then-act window the case study
  describes (`SELECT ... check refunded status ... INSERT`) is exactly
  what `SELECT ... FOR UPDATE` / a single atomic transaction closes,
  documented explicitly in `docs/architecture/ADR-002-concurrency-strategy.md`.

### Compare at least two concurrency control strategies for preventing this: pessimistic locking vs. SERIALIZABLE isolation. Show the SQL for each approach and discuss trade-offs.

**Pessimistic locking** (`SELECT ... FOR UPDATE`) — what this codebase
uses (`ADR-002-concurrency-strategy.md`):

```sql
BEGIN;
SELECT total_refunded FROM reversals
WHERE original_transaction_id = $1
FOR UPDATE;
-- application checks total_refunded + new_refund_amount <= original_amount
INSERT INTO reversals (...) VALUES (...);
COMMIT;
```

The row lock is held from the `SELECT` through `COMMIT`, so a second
concurrent request attempting the same `SELECT ... FOR UPDATE` blocks
until the first transaction resolves — the two requests are serialized
at the database level, eliminating the check-then-act window entirely.
**Trade-off**: reduces throughput under high contention on the _same_
original transaction (unlikely in practice — concurrent refunds against
the identical transaction are rare, so the serialization cost is paid
only when it matters) and requires careful lock ordering across
multi-account operations to avoid deadlocks (addressed in
`ConcurrencyControl` — consistent account-ID ordering before acquiring
locks).

**SERIALIZABLE isolation** (alternative):

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT total_refunded FROM reversals WHERE original_transaction_id = $1;
-- application checks total_refunded + new_refund_amount <= original_amount
INSERT INTO reversals (...) VALUES (...);
COMMIT;  -- one of two concurrent transactions gets a serialization failure here
```

No explicit lock is taken; instead, Postgres detects the conflict at
commit time and aborts one of the two competing transactions with a
serialization failure, which the application must catch and retry.
**Trade-off**: higher throughput when contention is genuinely rare (no
lock held for the transaction's full duration), but requires the
application to implement retry logic for aborted transactions, and abort
rates climb non-linearly under real contention — worse tail latency in
exactly the high-traffic scenario a refund-processing hot path might see
during, say, a mass chargeback event.

**Why this codebase chose pessimistic locking**: refund/reversal
correctness is a hard financial-integrity requirement, not a
best-effort optimization — a blocked request is a UX cost; a double-paid
refund is a realized financial loss and an audit finding. Pessimistic
locking trades a small amount of throughput for a guarantee that requires
no retry logic and can't silently succeed twice under any interleaving.

### Design a "refund ledger" pattern where the total refunded amount for any transaction is always derivable from the ledger entries (not stored as a mutable counter). Show the query.

This codebase already follows this principle — `total_refunded` for a
given original transaction is never a standalone mutable counter column;
it's derived from the `reversals` table (itself insert-only, following
the same no-mutation principle as `ledger_entries`) plus a direct
cross-check against posted `REFUND_FULL`/`REFUND_PARTIAL` journal entries:

```sql
SELECT COALESCE(SUM(le.amount), 0) AS total_refunded
FROM ledger_entries le
JOIN transactions t ON le.reference_id = t.id
WHERE t.reference_type IN ('REFUND_FULL', 'REFUND_PARTIAL')
  AND t.metadata->>'original_transaction_id' = $1
  AND le.account_id = $2          -- the specific wallet/merchant account
  AND le.status = 'POSTED'
GROUP BY le.account_id;
```

Deriving from the ledger rather than trusting a mutable counter means the
same immutability/hash-chain guarantees that protect every other balance
in the system also protect refund totals — a counter column could be
silently corrupted by a bug or an unauthorized `UPDATE`; a SUM over
immutable, hash-chained rows cannot be, without the tampering being
independently detectable via `AuditService.verifyChain()`.

### How would you implement a circuit breaker that automatically halts refund processing if the refund-to-transaction ratio exceeds a configurable threshold?

Following the circuit breaker pattern spec A10.4 already requires for
external dependencies (FX rate provider, payment gateway), a
refund-specific breaker would track a rolling window rather than a
single dependency's failure count:

1. **Track**: over a rolling window (e.g. 60 minutes), count total
   transactions processed vs. total `REFUND_FULL`/`REFUND_PARTIAL`
   transactions posted, per merchant and platform-wide.
2. **Closed (normal)**: refund ratio below threshold (e.g. 5%,
   configurable) — all refund requests processed normally.
3. **Open (tripped)**: ratio exceeds threshold — new refund requests are
   rejected with HTTP 503 and a `Retry-After` header (matching the
   existing error-response contract in spec A10.2), and an incident is
   raised for manual review rather than allowing refunds to continue
   silently at an anomalous rate — this is the guard that would have
   caught the hypothetical Razorpay scenario's _symptom_ (a spike in
   refund volume against a single transaction/merchant) even if the
   underlying race condition itself went unnoticed.
4. **Half-open**: after a cooldown, allow a small sample of refunds
   through; if the ratio normalizes, close the circuit; if not, re-open.
5. Implementation reuses the same breaker state machine already specified
   for FX/gateway/bank-transfer dependencies, parameterized by merchant
   ID and scoped to a rolling window rather than a fixed failure count —
   the mechanism is identical, only the trigger condition changes from
   "N failures in T seconds" to "refund ratio > X% in T minutes."

---

## Case Study 5: The Silicon Valley Bank Liquidity Ledger Blind Spot (2023)

### Design a real-time liquidity dashboard backed by your ledger. What queries would you run, and how would you ensure sub-second response times even with millions of entries?

SVB's failure mode was specifically that available-cash figures were
computed from stale, batch-reconciled data during a live crisis. The
defense is architectural: don't compute liquidity from a full ledger scan
at query time.

1. **Materialized balance snapshots**, not live aggregation:
   `balance_snapshots` (spec anti-pattern catalogue, row 2 — "Ledger
   Balance as Aggregate... Read performance degrades without materialised
   views or caching") already exists in this schema specifically to avoid
   recomputing `SUM(debits) - SUM(credits)` over the full history on every
   read. `BalanceService` updates the snapshot incrementally on each
   posted entry rather than deriving from scratch — turning a liquidity
   query from "scan the account's entire history" into "read one row."
2. **Query shape**: `SELECT account_id, balance FROM balance_snapshots
WHERE account_id IN (<all wallet/settlement accounts>)` — a
   point-lookup across indexed rows, not an aggregate scan — is what
   makes sub-second response times achievable at any ledger size, because
   response time no longer scales with total historical entry count.
3. **Real-time updates**: since `LedgerService.postJournalEntry()` posts
   inside a single DB transaction that also updates the relevant balance
   snapshots, the dashboard is never more than one committed transaction
   behind actual state — eliminating SVB's specific failure of decisions
   being made against a stale "previous day's closing balance plus
   partial inflows" figure.
4. For genuinely aggregate views (total platform liquidity across
   thousands of accounts), a rolling materialized view refreshed on a
   short interval (seconds, not the batch cadence SVB was reportedly
   using) trades a small staleness window for query speed at that scale
   — acceptable because individual account balances (the figures that
   actually drive withdrawal-honoring decisions) remain fully real-time
   via the snapshot table.

### How would your ledger handle a sudden spike of 10,000 withdrawal requests per minute? Describe the queuing, rate-limiting, and priority mechanisms you would implement.

1. **Concurrency control already prevents the dangerous failure mode**:
   `ConcurrencyControl`'s pessimistic locking (`ADR-002`) means concurrent
   withdrawals against the _same_ account serialize correctly regardless
   of request volume — the double-spend risk a naive check-then-act
   design would have under this load doesn't scale with request rate,
   because the lock, not application logic, enforces correctness.
2. **Rate limiting** (spec A10.1's 429 error category): requests beyond a
   configured per-account/per-second threshold get HTTP 429 with backoff
   guidance rather than being queued indefinitely — protects downstream
   capacity without silently dropping requests.
3. **Queuing for legitimate burst absorption**: rather than rejecting
   everything above instantaneous capacity, valid requests within
   reasonable limits are queued (not processed synchronously in the
   request/response cycle) so 10,000/minute — ~167/second — is well
   within what a properly indexed, partitioned Postgres instance can
   sustain for account-scoped writes, especially since most of those
   10,000 requests are almost certainly spread across many _different_
   accounts (true lock contention is per-account, not global).
4. **Priority is a business decision layered on top, not a technical
   one**: this codebase's job is to guarantee that _whatever_ order
   requests are honored in, the ledger stays correct (no double-spend, no
   negative balance) — SVB's actual failure was that "which withdrawals
   to honor" decisions were made against wrong data, not that they lacked
   a priority scheme. Correct real-time balances (via the snapshot
   architecture above) is the prerequisite that makes any priority policy
   trustworthy in the first place.

### Propose a "liquidity stress test" simulation that your system could run nightly: model a scenario where 40% of customer deposits are withdrawn within 24 hours and verify that the ledger can process all entries while maintaining consistency.

This is a direct extension of the existing stress-test infrastructure
(`tests/integration/stress-test.spec.ts`, which already runs 1,000+
randomized transactions across all 20 types and verifies the trial
balance stays exactly balanced) and the k6 load tests
(`tests/load/concurrent-withdrawal.js`, which already proves no
double-spend/negative-balance occurs under concurrent withdrawal load):

1. **Nightly simulation job**: snapshot current total customer deposit
   liability (`2001`), compute 40% of that figure, and generate that many
   `CUSTOMER_WITHDRAWAL` transactions distributed across the account
   population (weighted by existing balance, to mimic a realistic panic
   distribution rather than a uniform one) — run against a scratch/replica
   database, never production.
2. **Assertions**: (a) trial balance remains exactly balanced throughout
   and after the run — the same invariant the existing stress test
   already checks; (b) no account balance goes negative — the same
   invariant `concurrent-withdrawal.js` already checks under concurrency;
   (c) processing latency (p50/p95/p99) stays within the SLA target
   defined in spec A10.3's metrics requirements, under this specific
   _sustained, one-directional_ load pattern — which stresses the system
   differently than the existing mixed-transaction-type stress test does.
3. **Output**: a report analogous to `docs/reviews/` — pass/fail against
   defined thresholds, with any breach treated as an incident requiring
   the same `docs/incident-responses/` post-mortem discipline already
   established for the spec's Day 2/4/6/8/10/12/14 incident cards.

### Design an early-warning system that monitors the ratio of outflows to inflows over rolling 1-hour, 4-hour, and 24-hour windows, alerting management when thresholds are breached.

1. **Data source**: `ledger_entries` already carries `entry_type`
   (DEBIT/CREDIT) and `posted_at` per line for every customer-facing
   wallet account — the raw signal needed already exists without any
   schema change.
2. **Query shape** (per window, computed on a short refresh cycle, backed
   by the `idx_le_posted_at` index):
   ```sql
   SELECT
     SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END) AS outflow,
     SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END) AS inflow
   FROM ledger_entries
   WHERE account_id = ANY($1)  -- customer wallet accounts
     AND posted_at >= NOW() - INTERVAL '1 hour'
     AND status = 'POSTED';
   ```
   (Recall from `ADR-007`: for Asset-typed wallet accounts, CREDIT is the
   outflow direction and DEBIT is the inflow direction — getting this
   backwards here would silently invert the entire early-warning signal,
   which is exactly the class of error this repo's own audit found and
   fixed elsewhere; worth calling out explicitly in monitoring code for
   that reason.)
3. **Thresholds**: alert when the outflow:inflow ratio for the 1-hour
   window exceeds a level that would be anomalous relative to the
   account population's historical baseline (not a single hardcoded
   number — SVB's situation was itself an extreme historical outlier, so
   the baseline must be wide enough not to false-positive on ordinary
   payday/business-hours patterns), but the 1h/4h/24h _combination_ is
   what catches an accelerating run: a breach on the 1-hour window alone
   might be noise, but a breach on 1h _and_ 4h _and_ 24h simultaneously,
   each showing acceleration versus the prior window, is the signature
   SVB's post-mortem specifically flagged as the thing they couldn't see
   in time.
4. **Escalation**: routes to the same incident/paging path as the trial
   balance and hash-chain automated checks above — liquidity risk,
   accounting-integrity risk, and audit-integrity risk are three
   different failure modes, but this system treats "detect fast, alert
   immediately, log as an incident" as one consistent operational
   discipline across all three, rather than three different degrees of
   urgency.

### How would your schema support regulatory reconstruction? If a regulator demanded a complete ledger export with full audit trail for a specific date range, what format would you use, and how would you prove its integrity?

Identical mechanism to the Wirecard case study's export question above,
which is not a coincidence — SVB's post-mortem explicitly noted that
reconstruction "took weeks due to the complexity of interbank settlement
records... and multi-currency exposures," which is precisely the
combination of problems this schema is designed to avoid:

1. **Partitioning by `effective_date`** means a date-range export is a
   bounded, well-defined operation against a small number of partitions,
   not a full-table scan — the "took weeks" failure mode SVB experienced
   is largely a symptom of not being able to cheaply bound the extraction
   to the period a regulator actually cares about.
2. **Multi-currency exposure** is directly queryable via the currency
   exposure report (spec A6.3, `GET /api/v1/reports/fx-exposure`) rather
   than requiring ad hoc reconstruction from raw transaction logs across
   multiple systems.
3. **Format**: structured export (JSON/CSV) of the relevant
   `ledger_entries` partitions plus their `hash`/`previous_hash` chain,
   accompanied by a manifest recording the chain's start/end hashes for
   the period — the same tamper-evident export described for Case Study 3,
   reused here because "prove this data is what we actually recorded, not
   what we're claiming after the fact" is the same underlying requirement
   in both a fraud investigation and a liquidity-crisis reconstruction.
4. **Integrity proof**: a regulator (or their own auditors) can
   independently re-run `HashChainService.verifyChain()`'s algorithm
   against the exported rows without needing to trust this system's
   internal state — the chain is self-verifying by construction, which is
   the property that turns a "weeks of manual reconstruction" problem
   into a "run one verification script against the export" problem.
