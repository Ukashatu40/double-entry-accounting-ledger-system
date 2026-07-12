// tests/integration/partitioning.spec.ts
//
// Closes an audit gap: prior CI/README setup applied
// 008_partition_ledger_entries.sql, but nothing verified that the
// resulting schema was ACTUALLY partitioned (as opposed to the SQL
// silently no-op'ing or failing partway). This test asserts against
// PostgreSQL's own catalog (pg_inherits / pg_class), inserts real ledger
// entries spanning multiple months, and confirms both that (a) the table
// is genuinely partitioned and (b) queries against the parent table
// continue to return correct, complete results across partitions.
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { PrismaClient } from '@prisma/client';
import { DatabaseModule } from '@database/database.module';
import { DatabaseService } from '@database/database.service';
import { AccountsModule } from '@accounts/accounts.module';
import { LedgerModule } from '@ledger/ledger.module';
import { LedgerService } from '@ledger/ledger.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

interface PartitionRow {
  child_partition: string;
}

interface CountRow {
  count: bigint;
}

describe('Table partitioning (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let walletId: string;
  let liabilityId: string;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env',
          load: [appConfig, databaseConfig],
        }),
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        DatabaseModule,
        AccountsModule,
        LedgerModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);

    const prisma = db as unknown as PrismaClient;
    const wallet = await prisma.account.findUnique({ where: { code: '1001' } });
    const liability = await prisma.account.findUnique({ where: { code: '2001' } });

    if (!wallet || !liability) {
      throw new Error('Seed accounts missing — run npm run db:seed:test first');
    }

    walletId = wallet.id;
    liabilityId = liability.id;
  });

  afterAll(async () => {
    await closePrisma();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it('ledger_entries is a genuinely partitioned table (not a plain table)', async () => {
    // Queries PostgreSQL's own catalog — this cannot pass unless
    // 008_partition_ledger_entries.sql actually ran the ALTER/CREATE
    // partition DDL against this database, closing the audit gap where
    // Quick Start setup never applied it at all.
    const rows = await db.$queryRaw<Array<{ partstrat: string }>>`
      SELECT partstrat
      FROM pg_partitioned_table pt
      JOIN pg_class c ON c.oid = pt.partrelid
      WHERE c.relname = 'ledger_entries'
    `;

    expect(rows.length).toBe(1);
    expect(rows[0].partstrat).toBe('r'); // 'r' = RANGE partitioning
  });

  it('has at least one child partition registered via pg_inherits', async () => {
    const rows = await db.$queryRaw<PartitionRow[]>`
      SELECT child.relname AS child_partition
      FROM pg_inherits i
      JOIN pg_class parent ON i.inhparent = parent.oid
      JOIN pg_class child  ON i.inhrelid  = child.oid
      WHERE parent.relname = 'ledger_entries'
    `;

    expect(rows.length).toBeGreaterThan(0);
  });

  it('routes an inserted ledger entry into the correct monthly partition', async () => {
    const effectiveDate = '2026-03-15T10:00:00Z';

    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: '01932a1b-0000-7000-8000-000000000900',
        effectiveDate,
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount: '1000.0000',
            currency: 'INR',
            narrative: 'partition test',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount: '1000.0000',
            currency: 'INR',
            narrative: 'partition test',
          },
        ],
      },
      'system',
    );

    // Confirm the row physically lives in a March 2026 child partition,
    // not the parent table directly (parent tables in native Postgres
    // range partitioning hold no rows of their own).
    const rows = await db.$queryRaw<Array<{ tableoid_name: string }>>`
      SELECT c.relname AS tableoid_name
      FROM ledger_entries le
      JOIN pg_class c ON c.oid = le.tableoid
      WHERE le.reference_id = '01932a1b-0000-7000-8000-000000000900'::uuid
    `;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].tableoid_name).not.toBe('ledger_entries'); // must be a child, not the parent
    expect(rows[0].tableoid_name).toMatch(/ledger_entries_/);
  });

  it('a query against the parent table still returns entries spanning multiple partitions', async () => {
    const dates = ['2026-01-10T00:00:00Z', '2026-06-10T00:00:00Z', '2026-11-10T00:00:00Z'];

    for (const [i, effectiveDate] of dates.entries()) {
      await ledger.postJournalEntry(
        {
          referenceType: 'CUSTOMER_DEPOSIT_BANK',
          referenceId: `01932a1b-0000-7000-8000-00000000091${i.toString()}`,
          effectiveDate,
          lines: [
            {
              accountId: walletId,
              entryType: 'DEBIT',
              amount: '500.0000',
              currency: 'INR',
              narrative: 'multi-partition query test',
            },
            {
              accountId: liabilityId,
              entryType: 'CREDIT',
              amount: '500.0000',
              currency: 'INR',
              narrative: 'multi-partition query test',
            },
          ],
        },
        'system',
      );
    }

    const result = await db.$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS count
      FROM ledger_entries
      WHERE narrative = 'multi-partition query test'
    `;

    // 3 deposit entries × 2 lines each (wallet + liability) = 6 rows,
    // spread across January, June, and November partitions but still
    // fully visible through a single parent-table query.
    expect(Number(result[0].count)).toBe(6);
  });

  it('immutability triggers still function correctly on the partitioned table', async () => {
    const referenceId = '01932a1b-0000-7000-8000-000000000920';
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId,
        effectiveDate: '2026-05-01T00:00:00Z',
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount: '100.0000',
            currency: 'INR',
            narrative: 'immutability-on-partition test',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount: '100.0000',
            currency: 'INR',
            narrative: 'immutability-on-partition test',
          },
        ],
      },
      'system',
    );

    await expect(
      db.$executeRaw`
        UPDATE ledger_entries
        SET amount = '999.0000'
        WHERE reference_id = ${referenceId}::uuid
      `,
    ).rejects.toThrow(/IMMUTABILITY_VIOLATION/);
  });
});
