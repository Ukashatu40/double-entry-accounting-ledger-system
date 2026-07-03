// tests/integration/fx-conversion.spec.ts
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
import { TransactionsModule } from '@transactions/transactions.module';
import { TransactionsService } from '@transactions/transactions.service';
import { FxModule } from '@fx/fx.module';
import { FxRateService } from '@fx/fx-rate.service';
import { ReportingModule } from '@reporting/reporting.module';
import { TrialBalanceService } from '@reporting/trial-balance.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';
import Decimal from 'decimal.js';

jest.setTimeout(60_000);

describe('FX Conversion (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let transactions: TransactionsService;
  let fxRate: FxRateService;
  let trialBalance: TrialBalanceService;
  let walletUsdId: string;
  let walletInrId: string;
  let fxRevenueId: string;
  let fxHoldingUsdId: string;
  let fxHoldingInrId: string;
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
        TransactionsModule,
        FxModule,
        ReportingModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);
    transactions = app.get(TransactionsService);
    fxRate = app.get(FxRateService);
    trialBalance = app.get(TrialBalanceService);

    const prisma = db as unknown as PrismaClient;
    const [usd, inr, rev, holdUsd, holdInr, liab] = await Promise.all([
      prisma.account.findUnique({ where: { code: '1002' } }),
      prisma.account.findUnique({ where: { code: '1001' } }),
      prisma.account.findUnique({ where: { code: '4003' } }),
      prisma.account.findUnique({ where: { code: '1040' } }),
      prisma.account.findUnique({ where: { code: '1042' } }),
      prisma.account.findUnique({ where: { code: '2001' } }),
    ]);
    if (!usd || !inr || !rev || !holdUsd || !holdInr || !liab) {
      throw new Error('Seed accounts missing — run npm run db:seed:test (need account 1042)');
    }
    walletUsdId = usd.id;
    walletInrId = inr.id;
    fxRevenueId = rev.id;
    fxHoldingUsdId = holdUsd.id;
    fxHoldingInrId = holdInr.id;
    liabilityId = liab.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
    // Ensure a fresh, valid USD/INR rate exists for every test
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '83.5000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function fundUsdWallet(amount: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          {
            accountId: walletUsdId,
            entryType: 'DEBIT',
            amount,
            currency: 'USD',
            narrative: 'Fund USD',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'USD',
            narrative: 'Fund USD liability',
          },
        ],
      },
      'setup',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  it('converts USD to INR with correct debit/credit balance per currency leg', async () => {
    await fundUsdWallet('1000.0000');

    const result = await transactions.process(
      {
        type: 'FX_CONVERSION',
        effectiveDate: new Date().toISOString(),
        payload: {
          sourceWalletId: walletUsdId,
          targetWalletId: walletInrId,
          fxRevenueAccountId: fxRevenueId,
          fxHoldingSourceAccountId: fxHoldingUsdId,
          fxHoldingTargetAccountId: fxHoldingInrId,
          sourceAmount: '100.0000',
          exchangeRate: '83.5000',
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        },
      },
      'test_actor',
      `fx-idem-${uuidv7()}`,
      'test_actor',
    );

    expect(result.journal.totalDebits).toBe(result.journal.totalCredits);
  });

  it('trial balance remains balanced after an FX conversion', async () => {
    await fundUsdWallet('1000.0000');
    await transactions.process(
      {
        type: 'FX_CONVERSION',
        effectiveDate: new Date().toISOString(),
        payload: {
          sourceWalletId: walletUsdId,
          targetWalletId: walletInrId,
          fxRevenueAccountId: fxRevenueId,
          fxHoldingSourceAccountId: fxHoldingUsdId,
          fxHoldingTargetAccountId: fxHoldingInrId,
          sourceAmount: '50.0000',
          exchangeRate: '83.5000',
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        },
      },
      'test_actor',
      `fx-idem-${uuidv7()}`,
      'test_actor',
    );
    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
    expect(tb.discrepancy).toBe('0.0000');
  });

  it('target wallet receives grossAmount minus the 0.5% markup', async () => {
    await fundUsdWallet('1000.0000');
    const balanceBefore = new Decimal(await ledger.getAccountBalance(walletInrId));

    await transactions.process(
      {
        type: 'FX_CONVERSION',
        effectiveDate: new Date().toISOString(),
        payload: {
          sourceWalletId: walletUsdId,
          targetWalletId: walletInrId,
          fxRevenueAccountId: fxRevenueId,
          fxHoldingSourceAccountId: fxHoldingUsdId,
          fxHoldingTargetAccountId: fxHoldingInrId,
          sourceAmount: '100.0000',
          exchangeRate: '83.5000',
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        },
      },
      'test_actor',
      `fx-idem-${uuidv7()}`,
      'test_actor',
    );

    const balanceAfter = new Decimal(await ledger.getAccountBalance(walletInrId));
    const gross = new Decimal('100.0000').times('83.5000'); // 8350.0000
    const markup = gross.times('0.005').toDecimalPlaces(4); // 41.7500
    const netExpected = gross.minus(markup); // 8308.2500

    expect(balanceAfter.minus(balanceBefore).toFixed(4)).toBe(netExpected.toFixed(4));
  });

  it('rejects conversion when the rate is stale beyond FX_RATE_MAX_AGE_MINUTES', async () => {
    // Ingest a rate already outside the validity window by backdating capturedAt
    // via direct DB write (fxRate.ingestRate always sets capturedAt = now()).
    const prisma = db as unknown as PrismaClient;
    await prisma.exchangeRateSnapshot.updateMany({
      where: { baseCurrency: 'USD', quoteCurrency: 'INR', validUntil: null },
      data: { capturedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2 hours ago
    });

    await fundUsdWallet('1000.0000');

    await expect(
      transactions.process(
        {
          type: 'FX_CONVERSION',
          effectiveDate: new Date().toISOString(),
          payload: {
            sourceWalletId: walletUsdId,
            targetWalletId: walletInrId,
            fxRevenueAccountId: fxRevenueId,
            fxHoldingSourceAccountId: fxHoldingUsdId,
            fxHoldingTargetAccountId: fxHoldingInrId,
            sourceAmount: '10.0000',
            exchangeRate: '83.5000',
            sourceCurrency: 'USD',
            targetCurrency: 'INR',
          },
        },
        'test_actor',
        `fx-idem-${uuidv7()}`,
        'test_actor',
      ),
    ).rejects.toThrow('stale');
  });
});
