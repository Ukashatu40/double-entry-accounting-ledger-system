// tests/integration/fx-revaluation.spec.ts
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
import { FxModule } from '@fx/fx.module';
import { FxRateService } from '@fx/fx-rate.service';
import { FxRevaluationService } from '@fx/fx-revaluation.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

describe('FxRevaluationService (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let fxRate: FxRateService;
  let revaluation: FxRevaluationService;
  let walletUsdId: string;
  let liabilityId: string;
  let suspenseId: string;

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
        FxModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);
    fxRate = app.get(FxRateService);
    revaluation = app.get(FxRevaluationService);

    const prisma = db as unknown as PrismaClient;
    const [usd, liab, susp] = await Promise.all([
      prisma.account.findUnique({ where: { code: '1002' } }),
      prisma.account.findUnique({ where: { code: '2001' } }),
      prisma.account.findUnique({ where: { code: '1043' } }),
    ]);
    if (!usd || !liab || !susp) throw new Error('Seed accounts missing — need 1002, 2001, 1043');
    walletUsdId = usd.id;
    liabilityId = liab.id;
    suspenseId = susp.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
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

  it('produces no revaluation entries when there are no foreign balances', async () => {
    const result = await revaluation.runRevaluation(new Date(), suspenseId);
    expect(result.lines).toHaveLength(0);
    expect(result.journalId).toBeNull();
  });

  it('records an unrealised GAIN when the closing rate is higher than the prior rate', async () => {
    await fundUsdWallet('1000.0000');

    // Prior day's rate (cost basis)
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '82.0000',
      source: 'TEST',
      validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    // Today's closing rate — higher, so holding a USD balance shows a gain
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '84.0000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    });

    const result = await revaluation.runRevaluation(new Date(), suspenseId);

    expect(result.lines.length).toBeGreaterThan(0);
    const usdLine = result.lines.find((l) => l.currency === 'USD');
    expect(usdLine?.direction).toBe('GAIN');
    expect(result.journalId).not.toBeNull();
  });

  it('records an unrealised LOSS when the closing rate is lower than the prior rate', async () => {
    await fundUsdWallet('1000.0000');

    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '86.0000',
      source: 'TEST',
      validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '83.0000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    });

    const result = await revaluation.runRevaluation(new Date(), suspenseId);

    const usdLine = result.lines.find((l) => l.currency === 'USD');
    expect(usdLine?.direction).toBe('LOSS');
    expect(parseFloat(result.totalUnrealisedLoss)).toBeGreaterThan(0);
  });

  it('posts a balanced journal entry for the revaluation run', async () => {
    await fundUsdWallet('500.0000');
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '80.0000',
      source: 'TEST',
      validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '85.0000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    });

    const result = await revaluation.runRevaluation(new Date(), suspenseId);
    expect(result.journalId).not.toBeNull();

    const prisma = db as unknown as PrismaClient;
    const entries = await prisma.ledgerEntry.findMany({ where: { journalId: result.journalId! } });
    const debits = entries
      .filter((e) => e.entryType === 'DEBIT')
      .reduce((s, e) => s + parseFloat(e.amount.toString()), 0);
    const credits = entries
      .filter((e) => e.entryType === 'CREDIT')
      .reduce((s, e) => s + parseFloat(e.amount.toString()), 0);
    expect(debits).toBeCloseTo(credits, 4);
  });

  it('never touches the customer USD wallet balance itself', async () => {
    await fundUsdWallet('1000.0000');
    const balanceBefore = await ledger.getAccountBalance(walletUsdId);

    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '82.0000',
      source: 'TEST',
      validFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    await fxRate.ingestRate({
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '85.0000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    });

    await revaluation.runRevaluation(new Date(), suspenseId);

    const balanceAfter = await ledger.getAccountBalance(walletUsdId);
    expect(balanceAfter).toBe(balanceBefore); // unchanged — revaluation is reporting-only
  });
});
