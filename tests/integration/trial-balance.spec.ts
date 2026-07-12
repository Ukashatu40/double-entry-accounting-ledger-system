// tests/integration/trial-balance.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from '@database/database.module';
import { AccountsModule } from '@accounts/accounts.module';
import { LedgerModule } from '@ledger/ledger.module';
import { TransactionsModule } from '@transactions/transactions.module';
import { TransactionsService } from '@transactions/transactions.service';
import { ReportingModule } from '@reporting/reporting.module';
import { LedgerService } from '@ledger/ledger.service';
import { TrialBalanceService } from '@reporting/trial-balance.service';
import { DatabaseService } from '@database/database.service';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

describe('TrialBalanceService (integration)', () => {
  let app: TestingModule;
  let ledger: LedgerService;
  let transactions: TransactionsService;
  let trialBalance: TrialBalanceService;
  let db: DatabaseService;
  let walletId: string;
  let liabilityId: string;
  let feeRevenueId: string;
  let recipientWalletId: string;

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
        ReportingModule, // ← import the whole module, don't manually provide
      ],
    }).compile();

    ledger = app.get(LedgerService);
    transactions = app.get(TransactionsService);
    trialBalance = app.get(TrialBalanceService);
    db = app.get(DatabaseService);

    const prisma = db as unknown as PrismaClient;
    const wallet = await prisma.account.findUnique({ where: { code: '1001' } });
    const liability = await prisma.account.findUnique({ where: { code: '2001' } });
    const feeRevenue = await prisma.account.findUnique({ where: { code: '4001' } });

    if (!wallet || !liability || !feeRevenue) {
      throw new Error('Seed accounts missing');
    }

    walletId = wallet.id;
    liabilityId = liability.id;
    feeRevenueId = feeRevenue.id;

    // A second wallet-type account to act as the P2P recipient — the seed
    // only provisions one instance of code 1001, so a distinct GL account is
    // created here purely for this test's recipient leg.
    const recipient = await prisma.account.create({
      data: {
        id: uuidv7(),
        code: 'TEST-1001-B',
        name: 'Test Recipient Wallet',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
        status: 'ACTIVE',
      },
    });
    recipientWalletId = recipient.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function postDeposit(amount: string, refId: string): Promise<void> {
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: refId,
        effectiveDate: '2026-01-01T00:00:00Z',
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount,
            currency: 'INR',
            narrative: 'Deposit',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Liability',
          },
        ],
      },
      'system',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  it('returns isBalanced=true on an empty ledger', async () => {
    const report = await trialBalance.generate();
    expect(report.isBalanced).toBe(true);
    expect(report.discrepancy).toBe('0.0000');
  });

  it('remains balanced after a single deposit', async () => {
    await postDeposit('10000.0000', '01932a1b-0000-7000-8000-000000000100');
    const report = await trialBalance.generate();
    expect(report.isBalanced).toBe(true);
    expect(report.grandTotalDebits).toBe('10000.0000');
    expect(report.grandTotalCredits).toBe('10000.0000');
    expect(report.discrepancy).toBe('0.0000');
  });

  it('remains balanced after 50 random deposits', async () => {
    const amounts = Array.from({ length: 50 }, (_, i) => ((i + 1) * 1000).toFixed(4));

    for (let i = 0; i < amounts.length; i++) {
      await postDeposit(
        amounts[i]!,
        `01932a1b-0000-7000-8000-0000000${i.toString().padStart(5, '0')}`,
      );
    }

    const report = await trialBalance.generate();
    expect(report.isBalanced).toBe(true);
    expect(report.discrepancy).toBe('0.0000');
  });

  it('trial balance as-of date filters correctly', async () => {
    // Post in Jan 2026
    await postDeposit('5000.0000', '01932a1b-0000-7000-8000-000000000200');

    // Post in Mar 2026
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: '01932a1b-0000-7000-8000-000000000201',
        effectiveDate: '2026-03-01T00:00:00Z',
        lines: [
          {
            accountId: walletId,
            entryType: 'DEBIT',
            amount: '3000.0000',
            currency: 'INR',
            narrative: 'March deposit',
          },
          {
            accountId: liabilityId,
            entryType: 'CREDIT',
            amount: '3000.0000',
            currency: 'INR',
            narrative: 'March liability',
          },
        ],
      },
      'system',
      undefined,
      { checkBalanceOn: [] },
    );

    // As-of Feb — should only see Jan deposit
    const febReport = await trialBalance.generate(new Date('2026-02-01'));
    expect(febReport.grandTotalDebits).toBe('5000.0000');
    expect(febReport.isBalanced).toBe(true);

    // As-of Apr — should see both deposits
    const aprReport = await trialBalance.generate(new Date('2026-04-01'));
    expect(aprReport.grandTotalDebits).toBe('8000.0000');
    expect(aprReport.isBalanced).toBe(true);
  });

  it('remains balanced after a P2P transfer with fee', async () => {
    // First deposit to fund sender
    await postDeposit('10000.0000', '01932a1b-0000-7000-8000-000000000300');
    const balanceBeforeTransfer = await ledger.getAccountBalance(walletId);

    // Exercises the REAL P2pTransferHandler (not a hand-rolled entry) so this
    // test can't silently drift out of sync with the handler's actual sign
    // convention the way the old version did — see
    // docs/architecture/ADR-007-platform-operating-cash.md for why the
    // sender/recipient/fee legs are signed the way they are.
    await transactions.process(
      {
        type: 'P2P_TRANSFER',
        effectiveDate: '2026-01-01T00:00:00Z',
        payload: {
          senderWalletId: walletId,
          recipientWalletId: recipientWalletId,
          feeRevenueAccountId: feeRevenueId,
          amount: '5000.0000',
          currency: 'INR',
        },
      },
      'system',
      `p2p-idem-${uuidv7()}`,
      'system',
    );

    const report = await trialBalance.generate();
    expect(report.isBalanced).toBe(true);
    expect(report.discrepancy).toBe('0.0000');

    // Directional regression check — sender must have LESS money after
    // sending a P2P transfer, not more (the original polarity bug).
    const balanceAfterTransfer = await ledger.getAccountBalance(walletId);
    expect(parseFloat(String(balanceAfterTransfer))).toBeLessThan(
      parseFloat(String(balanceBeforeTransfer)),
    );

    const recipientBalance = await ledger.getAccountBalance(recipientWalletId);
    expect(parseFloat(String(recipientBalance))).toBe(5000);
  });
});
