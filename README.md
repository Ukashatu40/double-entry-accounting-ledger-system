# BED-6C-Ukashatu-Ledger

![CI](https://github.com/Ukashatu40/BED-6C-Ukashatu-Ledger/actions/workflows/ci.yml/badge.svg)
![Coverage](https://github.com/Ukashatu40/BED-6C-Ukashatu-Ledger/actions/workflows/coverage.yml/badge.svg)

**Neo-banking Ledger System with Double-Entry Accounting & Immutable Audit Trail**  
Zetheta Algorithms Assessment BED-6C | Intern ID: 493556B

---

## Overview

A production-grade financial ledger built on double-entry accounting principles with a cryptographic audit trail. Designed to the standards expected at Stripe, Revolut, Monzo, and similar fintech companies.

**Key capabilities:**

- 20 transaction types with correct debit/credit patterns
- SHA-256 hash chain on every ledger entry (tamper-evident)
- PostgreSQL advisory locks preventing double-spend
- `NUMERIC(19,4)` arithmetic throughout (zero floating point)
- Multi-currency FX engine with stale-rate rejection
- Full and partial reversals (3 fee policies)
- Trial balance, income statement, balance sheet, and FX exposure reports
- Idempotency on all state-mutating endpoints

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

# 5. Apply immutability triggers, table partitioning, and the Platform
#    Operating Cash system account (see docs/architecture/ADR-007)
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/003_immutability_triggers.sql
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/008_partition_ledger_entries.sql
docker exec -i ledger_postgres psql -U ledger_user -d ledger_db \
  < database/triggers/010_add_platform_operating_cash_account.sql

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

## Architecture

```text
src/
├── accounts/       Chart of Accounts (26 accounts seeded)
├── ledger/         Journal entry engine, hash chain, balance service
├── transactions/   20 transaction type handlers + idempotency
├── fx/             Exchange rate snapshots, stale-rate rejection
├── reversals/      Full and partial refunds, no-mutation principle
├── audit/          Hash chain verification, anomaly detection
├── reporting/      Trial balance, income statement, balance sheet
└── common/         Guards, filters, decorators, money types
```

**Tech stack:** NestJS 10 + Fastify | PostgreSQL 15 | Prisma 5 | decimal.js | UUID v7 | SHA-256

---

## API Reference

All endpoints require the `X-API-Key` header. State-mutating endpoints additionally require the `X-Idempotency-Key` header.

### Transactions

- `POST /api/v1/transactions` — Process any of the 20 transaction types

### Ledger

- `POST /api/v1/ledger/journal-entries` — Post a journal entry directly
- `GET /api/v1/ledger/journal-entries/:journalId` — Get journal lines
- `GET /api/v1/ledger/accounts/:id/entries` — Account ledger entries
- `GET /api/v1/ledger/accounts/:id/balance` — Derived account balance

### Accounts

- `GET /api/v1/accounts` — List Chart of Accounts
- `GET /api/v1/accounts/:id` — Account by ID
- `GET /api/v1/accounts/code/:code` — Account by code (e.g. `1001`)
- `POST /api/v1/accounts` — Create new account
- `PATCH /api/v1/accounts/:id/deactivate` — Deactivate account

### FX

- `POST /api/v1/fx/rates` — Ingest exchange rate snapshot
- `GET /api/v1/fx/rates/current` — Current rate for currency pair
- `GET /api/v1/fx/convert` — Preview conversion amount

### Reversals

- `POST /api/v1/reversals/full` — Full reversal
- `POST /api/v1/reversals/partial` — Partial refund (`PROPORTIONAL` / `FULL` / `NONE`)

### Reporting

- `GET /api/v1/reports/trial-balance`
- `GET /api/v1/reports/income-statement`
- `GET /api/v1/reports/balance-sheet`
- `GET /api/v1/reports/accounts/:id/statement`
- `GET /api/v1/reports/fx-exposure`

### Audit

- `GET /api/v1/audit/verify` — Hash chain verification
- `GET /api/v1/audit/anomalies` — Anomaly detection
- `GET /api/v1/audit/export` — Regulatory export

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
