// tests/integration/reconciliation.spec.ts
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
import { ReconciliationService } from '@reporting/reconciliation.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

describe('ReconciliationService (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let reconciliation: ReconciliationService;
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
    reconciliation = app.get(ReconciliationService);

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

  async function postDeposit(amount: string, referenceId: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId,
        effectiveDate: '2026-06-15T00:00:00Z',
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Recon test deposit',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Recon test liability',
          },
        ],
      },
      'recon-test',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  it('reports isFullyReconciled=true when ledger and external statement match exactly', async () => {
    const refId = uuidv7();
    await postDeposit('5000.0000', refId);

    const report = await reconciliation.reconcile(new Date('2026-06-01'), new Date('2026-06-30'), [
      {
        externalReference: refId,
        amount: '5000.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
    ]);

    expect(report.isFullyReconciled).toBe(true);
    expect(report.matchedCount).toBe(1);
    expect(report.totalDiscrepancyAmount).toBe('0.0000');
  });

  it('flags AMOUNT_MISMATCH when ledger and external amounts disagree', async () => {
    const refId = uuidv7();
    await postDeposit('5000.0000', refId);

    const report = await reconciliation.reconcile(new Date('2026-06-01'), new Date('2026-06-30'), [
      {
        externalReference: refId,
        amount: '4800.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
    ]);

    expect(report.isFullyReconciled).toBe(false);
    expect(report.amountMismatchCount).toBe(1);
    expect(report.lines[0]!.status).toBe('AMOUNT_MISMATCH');
    expect(report.totalDiscrepancyAmount).toBe('200.0000');
  });

  it('flags MISSING_IN_EXTERNAL when a ledger transaction has no external counterpart', async () => {
    const refId = uuidv7();
    await postDeposit('3000.0000', refId);

    const report = await reconciliation.reconcile(
      new Date('2026-06-01'),
      new Date('2026-06-30'),
      [], // empty external statement
    );

    expect(report.isFullyReconciled).toBe(false);
    expect(report.missingInExternalCount).toBe(1);
    expect(report.lines[0]!.status).toBe('MISSING_IN_EXTERNAL');
  });

  it('flags MISSING_IN_LEDGER when an external line has no ledger counterpart', async () => {
    const phantomRef = uuidv7();

    const report = await reconciliation.reconcile(new Date('2026-06-01'), new Date('2026-06-30'), [
      {
        externalReference: phantomRef,
        amount: '1000.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
    ]);

    expect(report.isFullyReconciled).toBe(false);
    expect(report.missingInLedgerCount).toBe(1);
    expect(report.lines[0]!.status).toBe('MISSING_IN_LEDGER');
  });

  it('tolerates sub-paisa rounding differences within the tolerance threshold', async () => {
    const refId = uuidv7();
    await postDeposit('1000.0000', refId);

    const report = await reconciliation.reconcile(new Date('2026-06-01'), new Date('2026-06-30'), [
      {
        externalReference: refId,
        amount: '1000.0050',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
    ]);

    expect(report.isFullyReconciled).toBe(true);
    expect(report.matchedCount).toBe(1);
  });

  it('correctly categorises a realistic mixed batch', async () => {
    const matchedRef = uuidv7();
    const mismatchRef = uuidv7();
    const missingExtRef = uuidv7();
    const phantomExtRef = uuidv7();

    await postDeposit('2000.0000', matchedRef);
    await postDeposit('3000.0000', mismatchRef);
    await postDeposit('1500.0000', missingExtRef);

    const report = await reconciliation.reconcile(new Date('2026-06-01'), new Date('2026-06-30'), [
      {
        externalReference: matchedRef,
        amount: '2000.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
      {
        externalReference: mismatchRef,
        amount: '2900.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
      {
        externalReference: phantomExtRef,
        amount: '500.0000',
        currency: 'INR',
        date: '2026-06-15T00:00:00Z',
      },
    ]);

    expect(report.matchedCount).toBe(1);
    expect(report.amountMismatchCount).toBe(1);
    expect(report.missingInExternalCount).toBe(1);
    expect(report.missingInLedgerCount).toBe(1);
    expect(report.isFullyReconciled).toBe(false);
  });
});
