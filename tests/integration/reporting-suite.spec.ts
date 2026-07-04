// tests/integration/reporting-suite.spec.ts
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
import { BalanceSheetService } from '@reporting/balance-sheet.service';
import { IncomeStatementService } from '@reporting/income-statement.service';
import { FxExposureService } from '@reporting/fx-exposure.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

describe('Balance Sheet, Income Statement, FX Exposure (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let balanceSheet: BalanceSheetService;
  let incomeStatement: IncomeStatementService;
  let fxExposure: FxExposureService;

  let walletId: string;
  let liabilityId: string;
  let feeRevenueId: string;
  let gatewayExpenseId: string;
  let walletUsdId: string;

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
    balanceSheet = app.get(BalanceSheetService);
    incomeStatement = app.get(IncomeStatementService);
    fxExposure = app.get(FxExposureService);

    const prisma = db as unknown as PrismaClient;
    const [wallet, liability, fee, gateway, usd] = await Promise.all([
      prisma.account.findUnique({ where: { code: '1001' } }),
      prisma.account.findUnique({ where: { code: '2001' } }),
      prisma.account.findUnique({ where: { code: '4001' } }),
      prisma.account.findUnique({ where: { code: '5001' } }),
      prisma.account.findUnique({ where: { code: '1002' } }),
    ]);
    if (!wallet || !liability || !fee || !gateway || !usd) {
      throw new Error('Seed accounts missing');
    }
    walletId = wallet.id;
    liabilityId = liability.id;
    feeRevenueId = fee.id;
    gatewayExpenseId = gateway.id;
    walletUsdId = usd.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function postDeposit(amount: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Report test deposit',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Report test liability',
          },
        ],
      },
      'report-test',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  async function postFeeRevenue(amount: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'FEE_DEDUCTION_MONTHLY',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Fee deduction',
          },
          {
            accountId: feeRevenueId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Fee revenue',
          },
        ],
      },
      'report-test',
      undefined,
      { checkBalanceOn: [walletId] },
    );
  }

  async function postExpense(amount: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_CARD',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          {
            accountId: gatewayExpenseId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Gateway expense',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Expense funding',
          },
        ],
      },
      'report-test',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  describe('BalanceSheetService', () => {
    it('satisfies Assets = Liabilities + Equity on an empty ledger', async () => {
      const result = await balanceSheet.generate(new Date());
      expect(result.isBalanced).toBe(true);
      expect(result.totalAssets).toBe('0.0000');
    });

    it('remains balanced after a deposit (Assets and Liabilities both increase)', async () => {
      await postDeposit('10000.0000');
      const result = await balanceSheet.generate(new Date());
      expect(result.isBalanced).toBe(true);
      expect(parseFloat(result.totalAssets)).toBeGreaterThan(0);
      expect(parseFloat(result.totalLiabilities)).toBeGreaterThan(0);
    });

    it('lists the wallet account under assets with the correct balance', async () => {
      await postDeposit('5000.0000');
      const result = await balanceSheet.generate(new Date());
      const walletLine = result.assets.find((a) => a.accountCode === '1001');
      expect(walletLine).toBeDefined();
      expect(walletLine!.balance).toBe('5000.0000');
    });
  });

  describe('IncomeStatementService', () => {
    it('returns zero revenue and expenses on an empty ledger', async () => {
      const result = await incomeStatement.generate(new Date('2026-01-01'), new Date('2026-12-31'));
      expect(result.totalRevenue).toBe('0.0000');
      expect(result.totalExpenses).toBe('0.0000');
      expect(result.netIncome).toBe('0.0000');
    });

    it('computes net income as revenue minus expenses', async () => {
      await postDeposit('50000.0000');
      await postFeeRevenue('200.0000');
      await postExpense('50.0000');

      const result = await incomeStatement.generate(new Date('2026-01-01'), new Date('2026-12-31'));
      expect(result.totalRevenue).toBe('200.0000');
      expect(result.totalExpenses).toBe('50.0000');
      expect(result.netIncome).toBe('150.0000');
    });

    it('scopes results to the given date range', async () => {
      await postDeposit('50000.0000');
      await postFeeRevenue('100.0000');

      const outsideRange = await incomeStatement.generate(
        new Date('2020-01-01'),
        new Date('2020-12-31'),
      );
      expect(outsideRange.totalRevenue).toBe('0.0000');
    });
  });

  describe('FxExposureService', () => {
    it('returns an empty exposure list when no foreign currency balances exist', async () => {
      const result = await fxExposure.generate(new Date());
      expect(result.exposures).toEqual([]);
      expect(result.totalInrEquivalent).toBe('0.0000');
    });

    it('reports USD exposure with an INR equivalent when a rate exists', async () => {
      const prisma = db as unknown as PrismaClient;
      await prisma.exchangeRateSnapshot.create({
        data: {
          id: uuidv7(),
          baseCurrency: 'USD',
          quoteCurrency: 'INR',
          rate: '83.5000',
          inverseRate: '0.01197605',
          source: 'TEST',
          capturedAt: new Date(),
          validFrom: new Date(),
          validUntil: null,
        },
      });

      await ledger.postJournalEntry(
        {
          referenceType: 'CUSTOMER_DEPOSIT_BANK',
          referenceId: uuidv7(),
          effectiveDate: new Date().toISOString(),
          lines: [
            {
              accountId: walletUsdId,
              entryType: 'DEBIT',
              amount: '100.0000',
              currency: 'USD',
              narrative: 'USD deposit',
            },
            {
              accountId: liabilityId,
              entryType: 'CREDIT',
              amount: '100.0000',
              currency: 'USD',
              narrative: 'USD liability',
            },
          ],
        },
        'report-test',
        undefined,
        { checkBalanceOn: [] },
      );

      const result = await fxExposure.generate(new Date());
      const usdExposure = result.exposures.find((e) => e.currency === 'USD');
      expect(usdExposure).toBeDefined();
      expect(usdExposure!.balance).toBe('100.0000');
      expect(usdExposure!.inrEquivalent).toBe('8350.0000');
    });
  });
});
