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
overridden by every handler that already had a `getBalanceCheckAccounts()`
debit-side account to protect — `NipTransferHandler`, `UssdTransferHandler`,
`P2pTransferHandler`, `BillPaymentHandler`, `FeeDeductionHandler`,
`FxConversionHandler`, `LoanEmiPaymentHandler`,
`MerchantPaymentOnlineHandler`, `MerchantPaymentQrHandler`, and
`WithdrawalHandler` — ten handlers in total. The remaining handlers
(deposits, interest accrual/payout, cashback, promotional credit, loan
disbursement, reversals, chargeback, reward redemption) are funding or
credit transactions with no customer-initiated wallet debit and, matching
this codebase's own existing judgment via `getBalanceCheckAccounts()`
already returning `[]` for those, were left without a limit check — a spend
cap is not a meaningful concept for money moving *into* an account.

The day/month aggregate check in `TransactionLimitService.assertWithinLimits()`
originally had its own check-then-act window — the same class of TOCTOU bug
fixed for refunds in `reversals.service.ts`, but for spend limits. This has
since been closed: `LedgerService.postJournalEntry()` accepts a
`limitChecks` option and runs `assertWithinLimits()` (now `tx`-aware)
*inside* the same advisory-locked transaction it already uses for balance
checks, acquiring locks on the union of both sets of accounts.
`BaseTransactionHandler.execute()` passes `getLimitCheckSpecs()`'s output
straight through rather than pre-checking it itself. `TransactionLimitService`
now lives in `src/ledger/` rather than `src/transactions/`, purely so
`LedgerService` can inject it without `TransactionsModule` ↔ `LedgerModule`
becoming a cycle (`TransactionsModule` already imports `LedgerModule`, so it
still gets the same instance). Verified under real concurrent load in
`tests/integration/ngn-localization.spec.ts` — three concurrent
`NIP_TRANSFER`s against a Tier-1 wallet's seeded daily cap, where exactly
two succeed and the third is rejected, every run.

**4. Stamp Duty, VAT, and the CBN Cybersecurity Levy all reuse the ADR-007
balancing-leg pattern.** Nigeria's Finance Act flat ₦50 stamp duty on
electronic transfers ≥ ₦10,000 (`src/transactions/handlers/stamp-duty.util.ts`),
7.5% VAT on the transaction fee, and the 0.005% CBN Cybersecurity Levy on
the transaction amount (both in `src/transactions/handlers/nigeria-levies.util.ts`)
are each modeled as an additional `computeBalancingLeg()`-compatible
journal leg — the same mechanism `p2p-transfer.handler.ts` and the other
ADR-007-pattern handlers already use for fee-splitting, extended here to
three real-money legs instead of one. All three post to their own CoA
liability accounts (`2041` Stamp Duty Payable, `2040` VAT Payable, `2042`
CBN Cybersecurity Levy Payable) on both `NIP_TRANSFER` and
`USSD_TRANSFER`. Unlike stamp duty, VAT and the levy are unconditional for
any NGN transaction on these two handlers (no threshold), since both are
percentage-based and never round to exactly zero for a positive amount —
the `.gt(0)` guard on each still exists so the same `computeVat()`/
`computeCybersecurityLevy()` functions stay safe to reuse on a
non-NGN-only handler in the future.

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
