# BED-6C-Ukashatu-Ledger

![CI](https://github.com/Ukashatu40/BED-6C-Ukashatu-Ledger/actions/workflows/ci.yml/badge.svg)
![Coverage](https://github.com/Ukashatu40/BED-6C-Ukashatu-Ledger/actions/workflows/coverage.yml/badge.svg)

**Neo-banking Ledger System with Double-Entry Accounting & Immutable Audit Trail**  
Personal project — double-entry ledger engine with India + Nigeria market localization

---

## Overview

A production-grade financial ledger built on double-entry accounting principles with a cryptographic audit trail. Designed to the standards expected at Stripe, Revolut, Monzo, and similar fintech companies.

**What this demonstrates:** double-entry correctness under a hostile test suite (a 1,000-transaction randomized stress test across all 22 types, verified for a balanced trial balance and an unbroken hash chain every run); real concurrency handling — not just sequential-looking async code, but advisory-locked transactions verified to correctly serialize genuinely concurrent requests (refunds, tiered spend limits) with `Promise.all`, not `await` in a loop; and an independently-modeled second market (Nigeria) built on the same architecture as the original India-flavored system, reusing its own established patterns (the ADR-007 balancing-leg mechanism) rather than bolting on special cases.

A frontend for this API is planned next — see `docs/api/openapi.yaml` for the current API contract (regenerate with `npm run docs:openapi` after any handler/DTO change).

**Key capabilities:**

- 22 transaction types with correct debit/credit patterns, including Nigeria's NIP (NIBSS Instant Payment) and USSD transfer rails
- SHA-256 hash chain on every ledger entry (tamper-evident)
- PostgreSQL advisory locks preventing double-spend, with concurrency correctness verified under real concurrent load (not just sequential tests)
- `NUMERIC(19,4)` arithmetic throughout (zero floating point)
- Multi-currency FX engine (INR, USD, EUR, GBP, JPY, AED, SGD, NGN) with stale-rate rejection
- Full and partial reversals (3 fee policies), with a TOCTOU-safe cumulative-refund guard
- CBN-style tiered KYC transaction limits, enforced inside the same advisory-locked transaction as the balance check
- Nigerian regulatory line items modeled as real journal legs: Finance Act stamp duty, VAT, CBN Cybersecurity Levy
- Trial balance, income statement, balance sheet, and FX exposure reports
- Idempotency on all state-mutating endpoints
- Global API rate limiting

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd BED-6C-Ukashatu-Ledger
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env if needed (defaults work with docker-compose)

# 3. Start database
docker compose up postgres -d

# 4. Run migrations and seed
npx prisma migrate deploy
npm run db:seed

# 5. Apply immutability triggers, table partitioning, the Platform
#    Operating Cash system account (ADR-007), and the NGN localization
#    accounts (ADR-008)
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/003_immutability_triggers.sql
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/008_partition_ledger_entries.sql
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/010_add_platform_operating_cash_account.sql
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/011_add_ngn_localization_accounts.sql

# 6. Start the API
npm run start:dev
```

> Steps 4–5 are intentionally separate from `docker compose up` (rather than
> baked into a container entrypoint) so each migration's effect is visible
> and inspectable during setup — see `docs/architecture/ADR-006-migration-strategy.md`.
> Re-running any of the SQL files above is safe; each is idempotent.

**API:** `http://localhost:3000/api/v1`  
**Swagger UI:** `http://localhost:3000/api/v1/docs`  
**Health Check:** `http://localhost:3000/api/v1/health`

---

## Deployment (Render + Neon)

The steps above (4–5) are for native local development, where you run
`npm run start:dev` directly and apply migrations by hand. The production
Docker image (the `production` target in the `Dockerfile`) is
self-contained and does none of that manually: `docker-entrypoint.sh`
applies Prisma migrations, seeds the Chart of Accounts on a genuinely
empty database, and applies the four trigger/data-migration SQL files —
in that order, every time the container boots, safely re-runnable on every
restart or redeploy. This was verified end-to-end against a completely
fresh, never-before-seeded database, not just assumed to work.

The database is [Neon](https://neon.tech) (serverless Postgres), not
Render's own Postgres add-on — `render.yaml` reflects that: it provisions
only the web service, not a database.

1. Create a Neon project (Postgres 15+).
2. Get the connection string from Neon's dashboard → **Connection Details**
   → **uncheck "Pooled connection"**. Use the **direct** string, not the
   `-pooler` one — this service runs Prisma migrations and raw
   multi-statement SQL (the trigger/data-migration files) at boot and
   keeps its own long-lived `pg.Pool` for the running app, none of which
   is safe over PgBouncer's transaction-pooling mode, which is what the
   pooled connection string routes through. The direct string already
   includes `?sslmode=require`; paste it exactly as Neon gives it.
3. In the Render dashboard, **New → Blueprint**, point it at this repo.
   `render.yaml` creates the web service with everything except
   `DATABASE_URL` pre-set (Blueprints can't pull secrets from an external
   provider) — paste Neon's direct connection string in as `DATABASE_URL`
   once the service exists.

**After the first deploy:** Render auto-generates `API_KEYS` — copy its
real value from the service's Environment tab into the frontend's
`LEDGER_API_KEY` on Vercel. The two must match exactly; nothing
coordinates this across the two platforms automatically.

**Cold starts, two layers:** Render's free web services spin down after
~15 minutes of inactivity and take 30–50+ seconds to wake back up.
Separately, Neon's free tier suspends its compute after a period of
inactivity and wakes on the next query, adding its own latency to a cold
first request. The frontend's proxy has a timeout budget sized for this —
see its own README — but the practical effect either way is that the
first request after a lull will be slow. This is a hosting-tier tradeoff,
not a bug; upgrading either plan reduces or removes it.

---

## Architecture

```text
src/
├── accounts/       Chart of Accounts (36 accounts seeded)
├── ledger/         Journal entry engine, hash chain, balance service,
│                   TransactionLimit enforcement (CBN-style tiered KYC caps)
├── transactions/   22 transaction type handlers + idempotency
├── fx/             Exchange rate snapshots, stale-rate rejection
├── reversals/      Full and partial refunds, no-mutation principle
├── audit/          Hash chain verification, anomaly detection
├── reporting/      Trial balance, income statement, balance sheet
└── common/         Guards, filters, decorators, money types
```

**Tech stack:** NestJS 10 + Fastify | PostgreSQL 15 | Prisma 7 | decimal.js | UUID v7 | SHA-256 | @nestjs/throttler

---

## Authorization

Access is still API-key based, not per-user accounts — but each key now resolves to one of three backend-enforced tiers instead of every valid key having identical full access:

| Role | Can do |
| --- | --- |
| `VIEWER` | Every `GET` endpoint. |
| `OPERATOR` | VIEWER + the routine day-to-day writes: submit transactions, create accounts, ingest FX rates, process reversals, run reconciliation. |
| `ADMIN` | OPERATOR + higher-blast-radius actions: deactivate accounts, post a raw journal entry (bypasses the transaction-type business-rule validation the normal `/transactions` endpoint enforces), run FX revaluation, export the full regulator audit package. |

Configure via `API_KEYS` as `key:ROLE` pairs (see `.env.example`); a bare key with no `:ROLE` defaults to `ADMIN`, so a single-key setup behaves exactly as before role tiers existed. `GET /api/v1/auth/whoami` returns the resolved role for whichever key called it — a route with no listed role requirement below accepts any authenticated key (VIEWER and up).

## API Reference

All endpoints require the `X-API-Key` header. State-mutating endpoints additionally require the `X-Idempotency-Key` header. Role column is the *minimum* tier required; blank means any authenticated key.

### Auth

- `GET /api/v1/auth/whoami` — Resolved role for the calling key

### Transactions

- `POST /api/v1/transactions` — Process any of the 22 transaction types · `OPERATOR`

### Ledger

- `POST /api/v1/ledger/journal-entries` — Post a journal entry directly · `ADMIN`
- `GET /api/v1/ledger/journal-entries/:journalId` — Get journal lines
- `GET /api/v1/ledger/accounts/:id/entries` — Account ledger entries
- `GET /api/v1/ledger/accounts/:id/balance` — Derived account balance

### Accounts

- `GET /api/v1/accounts` — List Chart of Accounts
- `GET /api/v1/accounts/:id` — Account by ID
- `GET /api/v1/accounts/code/:code` — Account by code (e.g. `1001`)
- `POST /api/v1/accounts` — Create new account · `OPERATOR`
- `PATCH /api/v1/accounts/:id/deactivate` — Deactivate account · `ADMIN`

### FX

- `POST /api/v1/fx/rates` — Ingest exchange rate snapshot · `OPERATOR`
- `GET /api/v1/fx/rates/current` — Current rate for currency pair
- `GET /api/v1/fx/convert` — Preview conversion amount
- `POST /api/v1/fx/revaluation/run` — Run FX revaluation batch · `ADMIN`

### Reversals

- `POST /api/v1/reversals/full` — Full reversal · `OPERATOR`
- `POST /api/v1/reversals/partial` — Partial refund (`PROPORTIONAL` / `FULL` / `NONE`) · `OPERATOR`

### Reporting

- `GET /api/v1/reports/trial-balance`
- `GET /api/v1/reports/income-statement`
- `GET /api/v1/reports/balance-sheet`
- `GET /api/v1/reports/accounts/:id/statement`
- `GET /api/v1/reports/fx-exposure`
- `POST /api/v1/reports/reconciliation` — Reconcile against an external statement · `OPERATOR`

### Audit

- `GET /api/v1/audit/verify` — Hash chain verification
- `GET /api/v1/audit/anomalies` — Anomaly detection
- `GET /api/v1/audit/export` — Regulatory export · `ADMIN`

---

## Testing

```bash
# Unit tests (no database required)
npm run test:unit

# Integration tests
npm run db:migrate:test
npm run db:seed:test
npm run test:integration

# Coverage report
npm run test:cov

# CLI utilities
npm run hash:verify      # Verify full hash chain
npm run trial-balance    # CLI trial balance check
```

---

## Key Design Decisions

| Decision         | Choice                               | Why                                                 |
| ---------------- | ------------------------------------ | --------------------------------------------------- |
| Balance storage  | Derived from ledger entries          | No update contention; immutable entries             |
| Concurrency      | Advisory locks + ordered acquisition | Lower abort rate than `SERIALIZABLE`; deadlock-free |
| Immutability     | Triggers + hash chain + app layer    | Three independent layers; DB-enforced               |
| Money arithmetic | decimal.js + `NUMERIC(19,4)`         | Prevents floating-point precision issues            |
| IDs              | UUID v7                              | Time-sortable; no enumeration attacks               |
| FX rates         | Snapshot with validity windows       | Stale-rate detection (Incident Day 6)               |

---

## Spec Errors Identified

See `docs/submission-notes.md` for a full analysis of the four deliberate errors found in the specification, how they were identified, and how the implementation corrects them.

See `docs/case-studies/case-study-analysis.md` for answers to all Part C case study analysis questions (Paytm, Revolut, Wirecard, Razorpay, SVB), each grounded in the actual mechanisms implemented here rather than generic prose.

---

## Compliance Notes

- RBI Master Directions: 10-year data retention policy implemented
- SOX Section 802: immutability triggers prevent record alteration
- PSD2: full audit trail with cryptographic integrity proof
- FEMA: LRS quota tracking on international transfers (metadata)
- IndAS 21: FX revaluation batch job scaffold (unrealised P&L)

## Documentation Artifacts

- **OpenAPI Specification**: `docs/api/openapi.yaml` — regenerate with `npm run docs:openapi`
- **Entity Relationship Diagram**: `docs/schema/erd.dbml` (source) and `docs/schema/erd-diagram.png` (rendered) — view/edit at [dbdiagram.io](https://dbdiagram.io)
