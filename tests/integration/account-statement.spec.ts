// tests/integration/account-statement.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { DatabaseModule } from '@database/database.module';
import { DatabaseService } from '@database/database.service';
import { AccountsModule } from '@accounts/accounts.module';
import { LedgerModule } from '@ledger/ledger.module';
import { LedgerService } from '@ledger/ledger.service';
import { ReportingModule } from '@reporting/reporting.module';
import { AccountStatementService } from '@reporting/account-statement.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

describe('AccountStatementService (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let statement: AccountStatementService;
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
        ReportingModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);
    statement = app.get(AccountStatementService);

    const prisma = db as unknown as PrismaClient;
    const wallet = await prisma.account.findUnique({ where: { code: '1001' } });
    const liability = await prisma.account.findUnique({ where: { code: '2001' } });
    if (!wallet || !liability) throw new Error('Seed accounts missing');
    walletId = wallet.id;
    liabilityId = liability.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function postDeposit(amount: string, effectiveDate: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: uuidv7(),
        effectiveDate,
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Statement test deposit',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Statement test liability',
          },
        ],
      },
      'stmt-test',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  it('returns opening balance 0 and correct closing balance for a fresh account', async () => {
    await postDeposit('1000.0000', '2026-03-15T00:00:00Z');

    const result = await statement.generate(
      walletId,
      new Date('2026-01-01'),
      new Date('2026-12-31'),
    );

    expect(result.openingBalance).toBe('0.0000');
    expect(result.closingBalance).toBe('1000.0000');
    expect(result.totalDebits).toBe('1000.0000');
  });

  it('computes correct opening balance from entries before the from-date', async () => {
    await postDeposit('1000.0000', '2026-01-15T00:00:00Z'); // before window
    await postDeposit('500.0000', '2026-03-15T00:00:00Z'); // inside window

    const result = await statement.generate(
      walletId,
      new Date('2026-02-01'),
      new Date('2026-12-31'),
    );

    expect(result.openingBalance).toBe('1000.0000');
    expect(result.closingBalance).toBe('1500.0000');
    expect(result.lines).toHaveLength(1); // only the in-window entry
  });

  it('produces a monotonically consistent running balance across multiple entries', async () => {
    await postDeposit('100.0000', '2026-01-01T00:00:00Z');
    await postDeposit('200.0000', '2026-01-02T00:00:00Z');
    await postDeposit('300.0000', '2026-01-03T00:00:00Z');

    const result = await statement.generate(
      walletId,
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]!.runningBalance).toBe('100.0000');
    expect(result.lines[1]!.runningBalance).toBe('300.0000');
    expect(result.lines[2]!.runningBalance).toBe('600.0000');
    expect(result.closingBalance).toBe('600.0000');
  });

  it('paginates results according to page and pageSize', async () => {
    for (let i = 0; i < 5; i++) {
      await postDeposit('10.0000', `2026-01-0${(i + 1).toString()}T00:00:00Z`);
    }

    const page1 = await statement.generate(
      walletId,
      new Date('2026-01-01'),
      new Date('2026-01-31'),
      1,
      2,
    );
    const page2 = await statement.generate(
      walletId,
      new Date('2026-01-01'),
      new Date('2026-01-31'),
      2,
      2,
    );

    expect(page1.lines).toHaveLength(2);
    expect(page2.lines).toHaveLength(2);
    expect(page1.lines[0]!.entryId).not.toBe(page2.lines[0]!.entryId);
  });
});
