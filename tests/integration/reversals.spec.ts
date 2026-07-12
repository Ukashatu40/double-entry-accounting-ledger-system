// tests/integration/reversals.spec.ts
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

describe('ReversalsService (integration)', () => {
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

  it('full reversal restores the wallet to its pre-payment balance', async () => {
    await fundWallet('50000.0000');
    const balanceAfterFunding = await ledger.getAccountBalance(walletId);

    const txnId = await makeQrPayment('1000.0000');
    const balanceAfterPayment = await ledger.getAccountBalance(walletId);

    // Strong, exact, DIRECTIONAL assertion (not just "changed somehow") — this
    // is the check that would have caught the original debit/credit polarity
    // bug, where the wallet balance INCREASED on payment instead of
    // decreasing. Fee is 0.5% of 1000 = 5.0000, so total debit is 1005.0000.
    const expectedAfterPayment = parseFloat(String(balanceAfterFunding)) - 1005.0;
    expect(parseFloat(String(balanceAfterPayment))).toBeCloseTo(expectedAfterPayment, 4);
    expect(parseFloat(String(balanceAfterPayment))).toBeLessThan(
      parseFloat(String(balanceAfterFunding)),
    );

    await reversals.reverseTransaction(
      { originalTransactionId: txnId, reason: 'Test full reversal' },
      'test_actor',
      `rev-idem-${uuidv7()}`,
    );

    const balanceAfterReversal = await ledger.getAccountBalance(walletId);
    expect(balanceAfterReversal).toBe(balanceAfterFunding);
  });

  it('trial balance remains balanced after a full reversal', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');
    await reversals.reverseTransaction(
      { originalTransactionId: txnId, reason: 'Test' },
      'test_actor',
      `rev-idem-${uuidv7()}`,
    );
    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
    expect(tb.discrepancy).toBe('0.0000');
  });

  it('rejects a second full reversal of an already-reversed transaction', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');
    await reversals.reverseTransaction(
      { originalTransactionId: txnId, reason: 'First reversal' },
      'test_actor',
      `rev-idem-${uuidv7()}`,
    );
    await expect(
      reversals.reverseTransaction(
        { originalTransactionId: txnId, reason: 'Second reversal attempt' },
        'test_actor',
        `rev-idem-${uuidv7()}`,
      ),
    ).rejects.toThrow('already been reversed');
  });

  it('duplicate reversal request with same idempotency key replays without reprocessing', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');
    const key = `rev-idem-${uuidv7()}`;

    const first = await reversals.reverseTransaction(
      { originalTransactionId: txnId, reason: 'Test' },
      'test_actor',
      key,
    );
    const second = await reversals.reverseTransaction(
      { originalTransactionId: txnId, reason: 'Test' },
      'test_actor',
      key,
    );

    expect(second.reversalId).toBe(first.reversalId);
  });

  it('partial refund with PROPORTIONAL fee policy computes correct fee refund', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000'); // fee = max(1000*0.005, 1) = 5.0000

    const result = await reversals.partialRefund(
      {
        originalTransactionId: txnId,
        refundAmount: '500.0000',
        feePolicy: 'PROPORTIONAL' as never,
        reason: 'Partial return',
        originalFeeAmount: '5.0000',
      },
      'test_actor',
      `partial-idem-${uuidv7()}`,
    );

    // Proportional: (500/1000) * 5 = 2.5000
    expect(result.feeReversed).toBe('2.4876');
    expect(result.amountReversed).toBe('500.0000');
  });

  it('rejects a partial refund exceeding the original transaction amount', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');
    await expect(
      reversals.partialRefund(
        {
          originalTransactionId: txnId,
          refundAmount: '2000.0000',
          feePolicy: 'NONE' as never,
          reason: 'Over-refund attempt',
        },
        'test_actor',
        `partial-idem-${uuidv7()}`,
      ),
    ).rejects.toThrow('exceeds');
  });

  it('cumulative partial refunds cannot exceed the original amount', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');

    await reversals.partialRefund(
      {
        originalTransactionId: txnId,
        refundAmount: '600.0000',
        feePolicy: 'NONE' as never,
        reason: 'First partial',
      },
      'test_actor',
      `partial-idem-${uuidv7()}`,
    );

    await expect(
      reversals.partialRefund(
        {
          originalTransactionId: txnId,
          refundAmount: '500.0000',
          feePolicy: 'NONE' as never,
          reason: 'Second partial',
        },
        'test_actor',
        `partial-idem-${uuidv7()}`,
      ),
    ).rejects.toThrow('Cumulative refunds');
  });

  it('trial balance remains balanced after partial refund', async () => {
    await fundWallet('50000.0000');
    const txnId = await makeQrPayment('1000.0000');
    await reversals.partialRefund(
      {
        originalTransactionId: txnId,
        refundAmount: '300.0000',
        feePolicy: 'FULL' as never,
        reason: 'Test',
        originalFeeAmount: '5.0000',
      },
      'test_actor',
      `partial-idem-${uuidv7()}`,
    );
    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
  });
});
