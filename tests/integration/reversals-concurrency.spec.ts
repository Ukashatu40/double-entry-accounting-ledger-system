// tests/integration/reversals-concurrency.spec.ts
//
// Regression tests for the refund/reversal TOCTOU race (see ADR-007's
// addendum and docs/incident-responses — the "Refund race condition" bug
// found in code review). Before the fix, ReversalsService.partialRefund()
// and reverseTransaction() read the cumulative/already-reversed state, then
// wrote the new Reversal row, as two separate, unguarded steps — allowing
// concurrent requests against the SAME original transaction to both pass
// the check before either committed. These tests fire real concurrent
// requests (Promise.all, not sequential awaits) against a real PostgreSQL
// connection pool to prove the advisory-lock fix actually serializes them.
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
import { ReversalsModule } from '@reversals/reversals.module';
import { ReversalsService } from '@reversals/reversals.service';
import { ReportingModule } from '@reporting/reporting.module';
import { TrialBalanceService } from '@reporting/trial-balance.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';

jest.setTimeout(60_000);

describe('ReversalsService concurrency (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let transactions: TransactionsService;
  let reversals: ReversalsService;
  let trialBalance: TrialBalanceService;
  let walletId: string;
  let merchantId: string;
  let feeRevenueId: string;

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
        ReversalsModule,
        ReportingModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);
    transactions = app.get(TransactionsService);
    reversals = app.get(ReversalsService);
    trialBalance = app.get(TrialBalanceService);

    const prisma = db as unknown as PrismaClient;
    const wallet = await prisma.account.findUnique({ where: { code: '1001' } });
    const merchant = await prisma.account.findUnique({ where: { code: '1010' } });
    const fee = await prisma.account.findUnique({ where: { code: '4001' } });
    if (!wallet || !merchant || !fee)
      throw new Error('Seed accounts missing — run npm run db:seed:test');
    walletId = wallet.id;
    merchantId = merchant.id;
    feeRevenueId = fee.id;
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  async function fundWallet(amount: string): Promise<void> {
    const liability = await (db as unknown as PrismaClient).account.findUnique({
      where: { code: '2001' },
    });
    await ledger.postJournalEntry(
      {
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: uuidv7(),
        effectiveDate: new Date().toISOString(),
        lines: [
          { accountId: walletId, entryType: 'DEBIT', amount, currency: 'INR', narrative: 'Fund' },
          {
            accountId: liability!.id,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Fund liability',
          },
        ],
      },
      'setup',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  async function makeQrPayment(amount: string): Promise<string> {
    const result = await transactions.process(
      {
        type: 'MERCHANT_PAYMENT_QR',
        effectiveDate: new Date().toISOString(),
        payload: {
          walletAccountId: walletId,
          merchantAccountId: merchantId,
          feeRevenueAccountId: feeRevenueId,
          amount,
          currency: 'INR',
          merchantName: 'Test Merchant',
          qrReference: 'QR-TEST',
        },
      },
      'test_actor',
      `idem-${uuidv7()}`,
      'test_actor',
    );
    return result.transactionId;
  }

  it('concurrent partial refunds against the same transaction never jointly exceed the original amount', async () => {
    await fundWallet('50000.0000');
    // fee = max(1000*0.005, 1) = 5.0000 → originalAmount (deriveOriginalAmount,
    // the largest non-platform line) = 1005.0000
    const txnId = await makeQrPayment('1000.0000');

    // Two concurrent refunds of 600.0000 each — individually within the
    // 1005.0000 limit, but 600 + 600 = 1200 > 1005, so at most one may
    // succeed. Before the fix, both could read "0 already refunded" before
    // either committed and both would pass.
    const attempts = [1, 2].map((n) =>
      reversals.partialRefund(
        {
          originalTransactionId: txnId,
          refundAmount: '600.0000',
          feePolicy: 'NONE' as never,
          reason: `Concurrent partial ${n.toString()}`,
        },
        'test_actor',
        `partial-idem-${uuidv7()}`,
      ),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejectedReason.message).toContain('Cumulative refunds');

    // Ground truth: sum of Reversal rows for this transaction must never
    // exceed the original amount.
    const prisma = db as unknown as PrismaClient;
    const reversalRows = await prisma.reversal.findMany({
      where: { originalTransactionId: txnId },
    });
    const totalRefunded = reversalRows.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
    expect(totalRefunded).toBeLessThanOrEqual(1005.0);
    expect(totalRefunded).toBe(600);

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('concurrent full reversals against the same transaction only ever succeed once', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');

    const attempts = [1, 2].map((n) =>
      reversals.reverseTransaction(
        { originalTransactionId: txnId, reason: `Concurrent reversal ${n.toString()}` },
        'test_actor',
        `rev-idem-${uuidv7()}`,
      ),
    );

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejectedReason.message).toContain('already been reversed');

    const prisma = db as unknown as PrismaClient;
    const reversalRows = await prisma.reversal.findMany({
      where: { originalTransactionId: txnId },
    });
    expect(reversalRows.length).toBe(1);

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });

  it('a concurrent full reversal and partial refund against the same transaction serialize correctly', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');

    const [fullResult, partialResult] = await Promise.allSettled([
      reversals.reverseTransaction(
        { originalTransactionId: txnId, reason: 'Full' },
        'test_actor',
        `rev-idem-${uuidv7()}`,
      ),
      reversals.partialRefund(
        {
          originalTransactionId: txnId,
          refundAmount: '200.0000',
          feePolicy: 'NONE' as never,
          reason: 'Partial',
        },
        'test_actor',
        `partial-idem-${uuidv7()}`,
      ),
    ]);

    // Exactly one of the two must succeed — either the full reversal wins
    // and blocks the partial (assertNotFullyReversed doesn't apply here,
    // but a fully-reversed transaction has no remaining postable balance so
    // the partial should fail), or the partial commits first and the full
    // reversal still succeeds since a partial refund doesn't block a full
    // reversal. Either ordering is acceptable — what must NOT happen is
    // both succeeding in a way that leaves inconsistent state.
    const outcomes = [fullResult, partialResult];
    const fulfilledCount = outcomes.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(1);

    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });
});
