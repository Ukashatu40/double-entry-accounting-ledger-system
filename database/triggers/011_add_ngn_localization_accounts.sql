-- database/triggers/011_add_ngn_localization_accounts.sql
-- Data migration: adds Nigerian-market (NGN) Chart of Accounts entries —
-- an NGN customer wallet, an NGN FX conversion holding account, and three
-- Nigerian regulatory liability accounts (VAT, Stamp Duty, CBN
-- Cybersecurity Levy). See docs/architecture/ADR-008-ngn-localization.md.
--
-- No schema/DDL change — this is the "adding a new account type" migration
-- referenced in spec A7.3's list of five required migration demonstrations,
-- the same class of migration as 010_add_platform_operating_cash_account.sql.
-- Idempotent: safe to re-run.
--
-- NOTE: unlike 010_..., this explicitly sets updated_at. The accounts.
-- updated_at column is NOT NULL with no database-level default — Prisma's
-- @updatedAt is a client-side behavior only (set by prisma.account.create()/
-- update(), not by a DB DEFAULT), so a raw INSERT that omits it fails a
-- NOT NULL constraint on a fresh database.

INSERT INTO accounts (id, code, name, type, sub_type, currency, status, description, created_at, updated_at)
VALUES
  (
    gen_random_uuid(),
    '1004',
    'Customer Wallet – NGN Holdings',
    'ASSET',
    'CURRENT_ASSET',
    'NGN',
    'ACTIVE',
    'NGN (Nigerian Naira) foreign currency wallet balance for customer accounts',
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    '1044',
    'FX Conversion Holding – NGN',
    'ASSET',
    'FX_HOLDING',
    'NGN',
    'ACTIVE',
    'Intermediate holding account used during NGN FX conversion entries',
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    '2040',
    'VAT Payable (NGN)',
    'LIABILITY',
    'CURRENT_LIABILITY',
    'NGN',
    'ACTIVE',
    'VAT collected at Nigeria''s standard 7.5% rate on transaction fees for NGN-denominated ' ||
    'transactions, per the Finance Act — illustrative modeling, not a compliance-certified rate feed.',
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    '2041',
    'Stamp Duty Payable (NGN)',
    'LIABILITY',
    'CURRENT_LIABILITY',
    'NGN',
    'ACTIVE',
    'Flat ₦50 stamp duty on qualifying electronic transfers of ₦10,000 or more, per the ' ||
    'Finance Act''s stamp duty provisions. See stamp-duty.util.ts.',
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    '2042',
    'CBN Cybersecurity Levy Payable (NGN)',
    'LIABILITY',
    'CURRENT_LIABILITY',
    'NGN',
    'ACTIVE',
    '0.005% levy on electronic transfers per the Cybercrime (Prohibition, Prevention, etc.) ' ||
    'Act as amended, remitted to the National Cybersecurity Fund via CBN. Seeded as a CoA ' ||
    'entry only in this change — not yet wired into a transaction handler (see ADR-008).',
    now(),
    now()
  )
ON CONFLICT (code) DO NOTHING;

-- Verify
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM accounts WHERE code IN ('1004', '1044', '2040', '2041', '2042')
  ) = 5, 'NGN localization accounts not found after migration';
  RAISE NOTICE 'Migration applied: 5 NGN localization accounts present';
END $$;
