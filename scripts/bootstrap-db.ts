// scripts/bootstrap-db.ts
// Runs on every container boot in production (Render has no separate
// one-off "release phase" the way some platforms do, so this must be safe
// to re-run on every restart/redeploy, not just the first one).
//
// Order matters and matches the README's manual setup steps exactly:
// 1. Seed the Chart of Accounts / exchange rates / transaction limits
//    FIRST, but only when the accounts table is genuinely empty — the
//    seed scripts use plain .create() calls, not upserts, so running them
//    against an already-seeded database would crash on a duplicate-key
//    error instead of silently double-seeding. (This emptiness check must
//    run before the trigger files below, not after — 010 and 011 each
//    insert a handful of accounts themselves, so checking afterward would
//    see a non-zero count on a fresh database and skip seeding entirely.)
// 2. Apply the trigger/data-migration SQL files. 003, 010, and 011 are
//    genuinely idempotent (DROP ... IF EXISTS / CREATE OR REPLACE /
//    ON CONFLICT DO NOTHING guards) and safe to re-run every boot. 008 is
//    NOT — it's a one-time structural conversion of ledger_entries to a
//    partitioned table (CREATE TABLE ledger_entries_y2025 etc., no IF NOT
//    EXISTS), so it's explicitly skipped below once that conversion has
//    already happened. This split was only found by testing a real
//    second boot against an already-migrated database — CI never catches
//    it because every CI job starts from a fresh, unmigrated database and
//    only ever runs these files once.
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

dotenv.config();

const TRIGGER_FILES = [
  '003_immutability_triggers.sql',
  '008_partition_ledger_entries.sql',
  '010_add_platform_operating_cash_account.sql',
  '011_add_ngn_localization_accounts.sql',
];

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM accounts',
    );
    const accountCount = parseInt(rows[0].count, 10);

    if (accountCount === 0) {
      console.log('→ Accounts table is empty — running seed...');
      execFileSync('node', [join(__dirname, '..', 'seeds', 'seed.js')], {
        stdio: 'inherit',
      });
    } else {
      console.log(`→ Accounts table already has ${accountCount} row(s) — skipping seed.`);
    }

    const triggersDir = join(__dirname, '..', '..', 'database', 'triggers');

    for (const file of TRIGGER_FILES) {
      if (file === '008_partition_ledger_entries.sql') {
        const { rows } = await pool.query<{ relkind: string }>(
          `SELECT relkind FROM pg_class WHERE relname = 'ledger_entries'`,
        );
        if (rows[0]?.relkind === 'p') {
          console.log(`→ Skipping ${file} — ledger_entries is already partitioned.`);
          continue;
        }
      }

      const sql = readFileSync(join(triggersDir, file), 'utf8');
      console.log(`→ Applying ${file}...`);
      // A single multi-statement query over the simple protocol (no
      // parameters) — the same thing `psql < file.sql` does, which is
      // what the README's manual steps and CI both use.
      await pool.query(sql);
    }

    console.log('✅ Database bootstrap complete.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('❌ Database bootstrap failed:', error);
  process.exit(1);
});
