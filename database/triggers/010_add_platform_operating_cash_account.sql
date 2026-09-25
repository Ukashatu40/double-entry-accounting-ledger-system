-- database/triggers/010_add_platform_operating_cash_account.sql
-- Data migration: adds a new account TYPE to the Chart of Accounts.
-- See docs/architecture/ADR-007-platform-operating-cash.md for why this
-- account is structurally required for fee/expense-splitting transactions
-- to balance with economically correct signs on the wallet leg.
--
-- No schema/DDL change — this is the "adding a new account type" migration
-- referenced in spec A7.3's list of five required migration demonstrations.
-- Idempotent: safe to re-run.

-- BUG FIX (found deploying against a genuinely fresh database — every
-- prior run had account 1050 already present from earlier seeding, so
-- ON CONFLICT DO NOTHING silently skipped the INSERT and never actually
-- exercised it): `updated_at` has no DB-level default (Prisma's
-- @updatedAt is an application-layer behavior, not a column DEFAULT), so
-- omitting it here violated the NOT NULL constraint on any real insert.
-- Same fix already applied in 011_add_ngn_localization_accounts.sql.
INSERT INTO accounts (id, code, name, type, sub_type, currency, status, description, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  '1050',
  'Platform Operating Cash',
  'ASSET',
  'CURRENT_ASSET',
  'INR',
  'ACTIVE',
  'System clearing account used to balance journal entries that split a ' ||
  'single wallet movement across a correctly-signed counterparty leg AND ' ||
  'a Revenue/Expense leg (e.g. P2P transfer with a fee, cashback funded ' ||
  'from bank operating cash). Not a caller-selectable account.',
  now(),
  now()
)
ON CONFLICT (code) DO NOTHING;

-- Verify
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM accounts WHERE code = '1050'
  ) = 1, 'Platform Operating Cash (1050) account not found after migration';
  RAISE NOTICE 'Migration applied: 1050 Platform Operating Cash account present';
END $$;