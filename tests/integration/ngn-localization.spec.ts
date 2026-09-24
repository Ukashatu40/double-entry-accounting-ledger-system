// tests/integration/ngn-localization.spec.ts
//
// End-to-end verification of the Nigerian (NGN) localization work: the
// NIP_TRANSFER handler (Finance Act stamp duty on qualifying amounts),
// CBN-tiered TransactionLimit enforcement (using the seeded
// TEST-NGN-TIER1/TIER3 demo wallets), and NGN FX rate resolution. See
// docs/architecture/ADR-008-ngn-localization.md.
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

describe('NGN localization (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let transactions: TransactionsService;
  let fxRate: FxRateService;
  let trialBalance: TrialBalanceService;
  let ngnWalletId: string;
  let recipientNgnWalletId: string;
  let feeRevenueId: string;
  let liabilityId: string;
  let tier1WalletId: string;
  let tier3WalletId: string;

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
    const [ngnWallet, feeRevenue, liability, tier1, tier3] = await Promise.all([
      prisma.account.findUnique({ where: { code: '1004' } }),
      prisma.account.findUnique({ where: { code: '4001' } }),
      prisma.account.findUnique({ where: { code: '2001' } }),
      prisma.account.findUnique({ where: { code: 'TEST-NGN-TIER1' } }),
      prisma.account.findUnique({ where: { code: 'TEST-NGN-TIER3' } }),
    ]);
    if (!ngnWallet || !feeRevenue || !liability || !tier1 || !tier3) {
      throw new Error('Seed accounts missing — run npm run db:seed:test');
    }
    ngnWalletId = ngnWallet.id;
    feeRevenueId = feeRevenue.id;
    liabilityId = liability.id;
    tier1WalletId = tier1.id;
    tier3WalletId = tier3.id;

    // A second NGN wallet to act as the NIP/USSD recipient.
    const recipient = await prisma.account.upsert({
      where: { code: 'TEST-1004-B' },
      update: {},
      create: {
        code: 'TEST-1004-B',
        name: 'Test Recipient NGN Wallet',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'NGN',
        status: 'ACTIVE',
      },
    });
    recipientNgnWalletId = recipient.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function fundNgnWallet(accountId: string, amount: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          {
            accountId,
            entryType: 'DEBIT',
            amount,
            currency: 'NGN',
            narrative: 'Fund NGN wallet',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'NGN',
            narrative: 'Fund liability',
          },
        ],
      },
      'setup',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  it('posts a NIP_TRANSFER below the stamp duty threshold with no stamp duty leg, fully balanced', async () => {
    await fundNgnWallet(ngnWalletId, '100000.0000');

    const result = await transactions.process(
      {
        type: 'NIP_TRANSFER',
        effectiveDate: new Date().toISOString(),
        payload: {
          senderWalletId: ngnWalletId,
          recipientWalletId: recipientNgnWalletId,
          feeRevenueAccountId: feeRevenueId,
          amount: '5000.0000',
          currency: 'NGN',
        },
      },
      'test_actor',
      `nip-idem-${uuidv7()}`,
      'test_actor',
    );

    expect(result.journal.totalDebits).toBe(result.journal.totalCredits);

    const prisma = db as unknown as PrismaClient;
    const stampDuty = await prisma.account.findUnique({ where: { code: '2041' } });
    const stampDutyEntry = result.journal.entries.find((e) => e.accountId === stampDuty?.id);
    expect(stampDutyEntry).toBeUndefined();

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('posts a NIP_TRANSFER at/above the ₦10,000 stamp duty threshold with a Stamp Duty Payable leg', async () => {
    await fundNgnWallet(ngnWalletId, '100000.0000');
    const prisma = db as unknown as PrismaClient;
    const stampDuty = await prisma.account.findUnique({ where: { code: '2041' } });
    if (!stampDuty) throw new Error('Stamp Duty Payable (2041) account missing');

    const result = await transactions.process(
      {
        type: 'NIP_TRANSFER',
        effectiveDate: new Date().toISOString(),
        payload: {
          senderWalletId: ngnWalletId,
          recipientWalletId: recipientNgnWalletId,
          feeRevenueAccountId: feeRevenueId,
          amount: '20000.0000',
          currency: 'NGN',
        },
      },
      'test_actor',
      `nip-idem-${uuidv7()}`,
      'test_actor',
    );

    expect(result.journal.totalDebits).toBe(result.journal.totalCredits);
    const stampDutyEntry = result.journal.entries.find((e) => e.accountId === stampDuty.id);
    expect(stampDutyEntry).toBeDefined();
    expect(stampDutyEntry?.entryType).toBe('CREDIT');
    expect(new Decimal(stampDutyEntry!.amount.toString()).toFixed(4)).toBe('50.0000');

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('posts VAT (7.5% of fee) and the CBN Cybersecurity Levy (0.005% of amount) on every NGN NIP_TRANSFER', async () => {
    await fundNgnWallet(ngnWalletId, '100000.0000');
    const prisma = db as unknown as PrismaClient;
    const [vat, levy] = await Promise.all([
      prisma.account.findUnique({ where: { code: '2040' } }),
      prisma.account.findUnique({ where: { code: '2042' } }),
    ]);
    if (!vat || !levy) throw new Error('VAT (2040) / Cybersecurity Levy (2042) accounts missing');

    const result = await transactions.process(
      {
        type: 'NIP_TRANSFER',
        effectiveDate: new Date().toISOString(),
        payload: {
          senderWalletId: ngnWalletId,
          recipientWalletId: recipientNgnWalletId,
          feeRevenueAccountId: feeRevenueId,
          amount: '5000.0000',
          currency: 'NGN',
        },
      },
      'test_actor',
      `nip-idem-${uuidv7()}`,
      'test_actor',
    );

    expect(result.journal.totalDebits).toBe(result.journal.totalCredits);

    const vatEntry = result.journal.entries.find((e) => e.accountId === vat.id);
    expect(vatEntry?.entryType).toBe('CREDIT');
    expect(new Decimal(vatEntry!.amount.toString()).toFixed(4)).toBe('2.0160'); // 7.5% of fee 26.8800

    const levyEntry = result.journal.entries.find((e) => e.accountId === levy.id);
    expect(levyEntry?.entryType).toBe('CREDIT');
    expect(new Decimal(levyEntry!.amount.toString()).toFixed(4)).toBe('0.2500'); // 0.005% of amount 5000

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('rejects a NIP_TRANSFER from a Tier-1 account that exceeds its seeded per-transaction limit', async () => {
    await fundNgnWallet(tier1WalletId, '5000000.0000');

    // Seeded TIER_1 maxPerTx = 50000.0000 (see kyc-tier.type.ts)
    await expect(
      transactions.process(
        {
          type: 'NIP_TRANSFER',
          effectiveDate: new Date().toISOString(),
          payload: {
            senderWalletId: tier1WalletId,
            recipientWalletId: recipientNgnWalletId,
            feeRevenueAccountId: feeRevenueId,
            amount: '60000.0000',
            currency: 'NGN',
          },
        },
        'test_actor',
        `nip-idem-${uuidv7()}`,
        'test_actor',
      ),
    ).rejects.toThrow('exceeds per-transaction limit');
  });

  it('concurrent NIP_TRANSFERs from the same Tier-1 wallet never jointly exceed the seeded daily limit (regression test for the TransactionLimitService TOCTOU fix)', async () => {
    await fundNgnWallet(tier1WalletId, '5000000.0000');

    // Seeded TIER_1 maxPerDay = 50000.0000. Each transfer's full debit
    // (amount + fee + stamp duty + VAT + levy) = 20079.8960, so two can
    // post (40159.7920 total) but a third must be rejected — before the
    // fix, concurrent requests could all read "0 posted today" before any
    // committed and all three could pass.
    const attempts = [1, 2, 3].map((n) =>
      transactions.process(
        {
          type: 'NIP_TRANSFER',
          effectiveDate: new Date().toISOString(),
          payload: {
            senderWalletId: tier1WalletId,
            recipientWalletId: recipientNgnWalletId,
            feeRevenueAccountId: feeRevenueId,
            amount: '20000.0000',
            currency: 'NGN',
          },
        },
        'test_actor',
        `nip-idem-concurrent-${n.toString()}-${uuidv7()}`,
        'test_actor',
      ),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(1);
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejectedReason.message).toContain('would exceed daily limit');

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('allows an equivalent transfer from a Tier-3 account (no configured limit)', async () => {
    await fundNgnWallet(tier3WalletId, '5000000.0000');

    const result = await transactions.process(
      {
        type: 'NIP_TRANSFER',
        effectiveDate: new Date().toISOString(),
        payload: {
          senderWalletId: tier3WalletId,
          recipientWalletId: recipientNgnWalletId,
          feeRevenueAccountId: feeRevenueId,
          amount: '60000.0000',
          currency: 'NGN',
        },
      },
      'test_actor',
      `nip-idem-${uuidv7()}`,
      'test_actor',
    );

    expect(result.journal.totalDebits).toBe(result.journal.totalCredits);
  });

  it('resolves seeded USD/NGN and NGN/INR exchange rates', async () => {
    const usdNgn = await fxRate.getCurrentRate('USD', 'NGN');
    expect(parseFloat(usdNgn.rate.toString())).toBeGreaterThan(0);

    const ngnInr = await fxRate.getCurrentRate('NGN', 'INR');
    expect(parseFloat(ngnInr.rate.toString())).toBeGreaterThan(0);
  });
});
