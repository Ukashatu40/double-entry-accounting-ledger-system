# ADR-008: Nigerian (NGN) Market Localization

**Status:** Accepted
**Date:** 2026-09-24

## Context

This codebase is an India-flavored neobank case study ("NovaPay") with no
Nigerian-market support anywhere — NGN did not exist in the `Currency` enum,
the Chart of Accounts, or any seeded FX rate, and there was no notion of
tiered KYC limits despite `Account.metadata` and the `TransactionLimit`
table both being present specifically to support that. This localization
targets the India↔Nigeria remittance corridor and demonstrates the same
engineering rigor already applied to the India-specific parts of the system
(ADR-004 precision strategy, ADR-007 balancing-leg pattern) on a second,
independently-modeled market.

Two pre-existing architectural facts made this additive rather than
invasive: currency is stored as free-text `String @db.Char(3)` throughout
the schema (no DB enum lock-in), and the handler-per-transaction-type
pattern (`BaseTransactionHandler` + a flat registry in
`TransactionsService`) is a proven, 20-times-repeated extension point.

## Decision

**1. Currency onboarding is purely additive.** `NGN` was added to the
`Currency` enum and `CURRENCY_DECIMALS` map
(`src/common/types/currency.type.ts`) — no schema migration needed for the
currency value itself. Two pre-existing validation gaps were fixed as
prerequisites: `create-account.dto.ts` had a `SUPPORTED_CURRENCIES` import
commented out (only regex-validating "3 uppercase letters", not real
membership), and `exchange-rate.dto.ts` had the same weak regex-only check.
Both now use `@IsIn(SUPPORTED_CURRENCIES)`. `NGN/INR` was seeded directly
(not just NGN vs USD/EUR/GBP) because FX rate lookup
(`FxRateRepository.findCurrent`) is an exact `{base, quote}` match with no
cross-rate computation, and this system's home/reporting currency is INR.

**2. KYC tier lives in `Account.metadata` JSON, not a new column or table.**
The schema's own doc comment on `Account.metadata`
(`prisma/schema.prisma`) already names "KYC tier" as an intended use of
that field. A dedicated `kycTier` column would be `NULL` for the vast
majority of accounts (only customer wallets have a tier; revenue/system
accounts never would), which is a worse fit than an optional JSON field.
The actual limit *numbers* belong in the already-existing, purpose-built
`TransactionLimit` table — `kycTier` is purely a classification used at
account-provisioning time to decide which `TransactionLimit` rows to
create, never read at transaction time (see `src/common/types/kyc-tier.type.ts`).

**3. `TransactionLimit` enforcement is generic and opt-in, not NGN-specific.**
This table existed in the schema before this change but was completely
unused — every handler hardcoded its own fee/limit constants instead. Fixing
that gap generically (rather than bolting a Nigeria-only check onto the two
new handlers) is the correct scope: `TransactionLimitService`
(`src/transactions/transaction-limit.service.ts`) reads the table and is
wired into `BaseTransactionHandler` via a new opt-in hook,
`getLimitCheckSpecs()`, called from `execute()` before posting — the same
opt-in shape as the pre-existing `getBalanceCheckAccounts()`. It is
overridden by `NipTransferHandler`, `UssdTransferHandler`, and — to prove
the mechanism is genuinely generic — `P2pTransferHandler` as one retrofit
example. Extending it to the remaining 17 handlers is a mechanical,
one-line-per-handler follow-up, intentionally left out of this change to
keep the diff reviewable.

Known limitation, documented rather than fixed here: the day/month
aggregate check in `TransactionLimitService.assertWithinLimits()` has its
own check-then-act window — structurally the same class of bug as the
refund TOCTOU fixed in `reversals.service.ts` (see ADR context in that
file), but for spend limits rather than refunds. A future pass should
thread this check into `LedgerService.postJournalEntry()`'s existing
advisory-locked transaction rather than checking before that lock is taken.

**4. Stamp Duty reuses the ADR-007 balancing-leg pattern; VAT and the CBN
Cybersecurity Levy are seeded but not wired.** Nigeria's Finance Act flat
₦50 stamp duty on electronic transfers ≥ ₦10,000
(`src/transactions/handlers/stamp-duty.util.ts`) is modeled as an
additional `computeBalancingLeg()`-compatible journal leg — the same
mechanism `p2p-transfer.handler.ts` and the other ADR-007-pattern handlers
already use for fee-splitting, extended to a third real-money leg. VAT
Payable (7.5%, account `2040`) and the CBN Cybersecurity Levy (0.005%,
account `2042`) were added to the Chart of Accounts in this change but are
**not** wired into any handler — they exist as CoA entries with a
documented extension path, not as functioning code. Do not assume either
is enforced anywhere.

## Consequences

- New CoA accounts: `1004` (NGN wallet), `1044` (NGN FX holding), `2040`
  (VAT Payable), `2041` (Stamp Duty Payable), `2042` (CBN Cybersecurity
  Levy Payable) — see `database/triggers/011_add_ngn_localization_accounts.sql`.
- New `TransactionType` enum values `NIP_TRANSFER` and `USSD_TRANSFER` —
  additive `ALTER TYPE ... ADD VALUE`, non-blocking in PostgreSQL 12+, does
  not require the rename/backfill pattern that applies only to destructive
  enum changes.
- The `tx` option added to `LedgerService.postJournalEntry()` (for the
  refund TOCTOU fix — see `reversals.service.ts`) is also the mechanism any
  future NGN-related transactional composition should reuse if it needs to
  post a journal entry as part of a larger atomic operation.
- Fee, limit, and stamp-duty constants in `nip-transfer.handler.ts` /
  `ussd-transfer.handler.ts` are explicitly illustrative (commented as
  such), not live NIBSS tariffs or CBN-published figures — this is a
  demonstration of the modeling pattern, not a production-ready Nigerian
  payment integration.

## Migration

`prisma/migrations/20260924130225_add_nigeria_transaction_types/migration.sql`
(the `TransactionType` enum additions) and
`database/triggers/011_add_ngn_localization_accounts.sql` (the CoA data
migration — idempotent, `ON CONFLICT (code) DO NOTHING`). Unlike
`010_add_platform_operating_cash_account.sql`, the new migration explicitly
sets `updated_at`, since `Account.updatedAt`'s `@updatedAt` is a
Prisma-client-side behavior (set by `.create()`/`.update()`), not a
database-level `DEFAULT` — a raw `INSERT` that omits it fails a `NOT NULL`
constraint on a fresh database.
