// tests/integration/stress-test.spec.ts
// Day 15 deliverable: 1,000-transaction randomised stress test across all 20 types
// Also satisfies Day 9's 500-transaction requirement and the "Zero-Defect Ledger"
// achievement badge (spec Part B5).
//
// Strategy: attempt 1,000 transactions spread across all 20 types. Business-rule
// rejections (insufficient balance, validation errors) are EXPECTED and do not
// fail the test — only entries that DO post must keep the trial balance and
// hash chain valid. At the end we assert:
//   1. All 20 transaction types were successfully exercised at least once
//   2. Trial balance is balanced (debits === credits) after all 1,000 attempts
//   3. Hash chain remains cryptographically valid across every posted entry

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
import { AuditModule } from '@audit/audit.module';
import { AuditService } from '@audit/audit.service';
import { cleanDatabase, closePrisma } from './setup';
import appConfig from '@config/app.config';
import databaseConfig from '@config/database.config';
import type { TransactionType } from '@prisma/client';

jest.setTimeout(180_000); // 1,000 sequential DB transactions need headroom

describe('1,000-transaction stress test across all 20 types (integration)', () => {
  let app: TestingModule;
  let db: DatabaseService;
  let ledger: LedgerService;
  let transactions: TransactionsService;
  let reversals: ReversalsService;
  let trialBalance: TrialBalanceService;
  let audit: AuditService;

  // Semantic account name → UUID
  const A: Record<string, string> = {};

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
        AuditModule,
      ],
    }).compile();

    db = app.get(DatabaseService);
    ledger = app.get(LedgerService);
    transactions = app.get(TransactionsService);
    reversals = app.get(ReversalsService);
    trialBalance = app.get(TrialBalanceService);
    audit = app.get(AuditService);

    await cleanDatabase();

    const prisma = db as unknown as PrismaClient;

    // ── Resolve all seeded accounts by code ──────────────────────────────────
    const codes: Record<string, string> = {
      wallet: '1001',
      walletUsd: '1002',
      merchantSettlement: '1010',
      loanReceivable: '1020',
      interestReceivable: '1030',
      liability: '2001',
      merchantPayable: '2002',
      interestPayable: '2010',
      tdsPayable: '2020',
      rewardsLiability: '2030',
      feeRevenue: '4001',
      interestIncome: '4002',
      fxRevenue: '4003',
      chargebackFeeRevenue: '4030',
      gatewayExpense: '5001',
      cashbackExpense: '5002',
      interestExpense: '5003',
      fxHoldingUsd: '1040',
      fxHoldingInr: '1042',
    };

    for (const [key, code] of Object.entries(codes)) {
      const account = await prisma.account.findUnique({ where: { code } });
      if (!account)
        throw new Error(`Seed account ${code} (${key}) not found — run npm run db:seed:test`);
      A[key] = account.id;
    }

    await prisma.account.deleteMany({
      where: {
        code: { in: ['1098-STRESS', '1099-STRESS'] }, // Replace with your test codes
      },
    });

    // ── Create two accounts not present in the seed ──────────────────────────
    const secondWallet = await prisma.account.upsert({
      where: { code: '1098-STRESS' },
      update: {}, // Do nothing if it already exists
      create: {
        id: uuidv7(),
        code: '1098-STRESS',
        name: 'Customer Wallet – Stress Test Secondary',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
      },
    });
    A['wallet2'] = secondWallet.id;

    const biller = await prisma.account.create({
      data: {
        id: uuidv7(),
        code: '1099-STRESS',
        name: 'Biller Settlement – Stress Test',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
      },
    });
    A['biller'] = biller.id;

    // ── Fund both wallets generously so random transactions don't starve ────
    await fundWallet(A['wallet']!, '5000000.0000');
    await fundWallet(A['wallet2']!, '5000000.0000');
    await fundWalletUsd(A['walletUsd']!, '500000.0000');
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function fundWallet(walletId: string, amount: string): Promise<void> {
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
            narrative: 'Stress test funding',
          },
          {
            accountId: A['liability']!,
            entryType: 'CREDIT',
            amount,
            currency: 'INR',
            narrative: 'Stress test funding liability',
          },
        ],
      },
      'stress-test-setup',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  async function fundWalletUsd(walletId: string, amount: string): Promise<void> {
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
            currency: 'USD',
            narrative: 'Stress test USD funding',
          },
          {
            accountId: A['liability']!,
            entryType: 'CREDIT',
            amount,
            currency: 'USD',
            narrative: 'Stress test USD funding liability',
          },
        ],
      },
      'stress-test-setup',
      undefined,
      { checkBalanceOn: [] },
    );
  }

  function amt(min: number, max: number): string {
    return (Math.random() * (max - min) + min).toFixed(4);
  }

  function idem(): string {
    return `stress-${uuidv7()}`;
  }

  // Type-specific payload generators — return the DTO shape TransactionsService.process expects
  const generators: Record<
    string,
    () => { type: TransactionType; effectiveDate: string; payload: Record<string, unknown> }
  > = {
    CUSTOMER_DEPOSIT_BANK: () => ({
      type: 'CUSTOMER_DEPOSIT_BANK',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        liabilityAccountId: A['liability'],
        amount: amt(100, 5000),
        currency: 'INR',
        reference: 'NEFT',
      },
    }),
    CUSTOMER_DEPOSIT_CARD: () => ({
      type: 'CUSTOMER_DEPOSIT_CARD',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        liabilityAccountId: A['liability'],
        gatewayExpenseAccountId: A['gatewayExpense'],
        merchantPayableAccountId: A['merchantPayable'],
        amount: amt(100, 3000),
        currency: 'INR',
        cardLast4: '4242',
        network: 'VISA',
      },
    }),
    CUSTOMER_WITHDRAWAL_BANK: () => ({
      type: 'CUSTOMER_WITHDRAWAL_BANK',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        liabilityAccountId: A['liability'],
        amount: amt(50, 500),
        currency: 'INR',
        beneficiary: 'Test Bank',
      },
    }),
    P2P_TRANSFER: () => ({
      type: 'P2P_TRANSFER',
      effectiveDate: new Date().toISOString(),
      payload: {
        senderWalletId: A['wallet'],
        recipientWalletId: A['wallet2'],
        feeRevenueAccountId: A['feeRevenue'],
        amount: amt(10, 300),
        currency: 'INR',
      },
    }),
    MERCHANT_PAYMENT_QR: () => ({
      type: 'MERCHANT_PAYMENT_QR',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        merchantAccountId: A['merchantSettlement'],
        feeRevenueAccountId: A['feeRevenue'],
        amount: amt(20, 1000),
        currency: 'INR',
        merchantName: 'Stress Merchant',
        qrReference: 'QR-STRESS',
      },
    }),
    MERCHANT_PAYMENT_ONLINE: () => ({
      type: 'MERCHANT_PAYMENT_ONLINE',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        merchantAccountId: A['merchantSettlement'],
        feeRevenueAccountId: A['feeRevenue'],
        amount: amt(20, 1000),
        currency: 'INR',
        merchantName: 'Stress Online Merchant',
        orderId: 'ORD-STRESS',
      },
    }),
    BILL_PAYMENT: () => ({
      type: 'BILL_PAYMENT',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        billerAccountId: A['biller'],
        feeRevenueAccountId: A['feeRevenue'],
        amount: amt(50, 2000),
        currency: 'INR',
        billerName: 'Stress Electricity Co',
        billReference: 'BILL-STRESS',
      },
    }),
    INTEREST_ACCRUAL: () => ({
      type: 'INTEREST_ACCRUAL',
      effectiveDate: new Date().toISOString(),
      payload: {
        interestExpenseAccountId: A['interestExpense'],
        interestPayableAccountId: A['interestPayable'],
        principal: '100000.0000',
        annualRate: '0.04',
        currency: 'INR',
      },
    }),
    FEE_DEDUCTION_MONTHLY: () => ({
      type: 'FEE_DEDUCTION_MONTHLY',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        feeRevenueAccountId: A['feeRevenue'],
        amount: amt(10, 100),
        currency: 'INR',
        feeType: 'Monthly Maintenance Fee',
      },
    }),
    CASHBACK_CREDIT: () => ({
      type: 'CASHBACK_CREDIT',
      effectiveDate: new Date().toISOString(),
      payload: {
        cashbackExpenseAccountId: A['cashbackExpense'],
        walletAccountId: A['wallet'],
        amount: amt(5, 200),
        currency: 'INR',
      },
    }),
    PROMOTIONAL_CREDIT: () => ({
      type: 'PROMOTIONAL_CREDIT',
      effectiveDate: new Date().toISOString(),
      payload: {
        cashbackExpenseAccountId: A['cashbackExpense'],
        walletAccountId: A['wallet'],
        amount: amt(5, 150),
        currency: 'INR',
        promoCode: 'STRESS10',
      },
    }),
    FX_CONVERSION: () => ({
      type: 'FX_CONVERSION',
      effectiveDate: new Date().toISOString(),
      payload: {
        sourceWalletId: A['walletUsd'],
        targetWalletId: A['wallet'],
        fxRevenueAccountId: A['fxRevenue'],
        fxHoldingSourceAccountId: A['fxHoldingUsd'],
        fxHoldingTargetAccountId: A['fxHoldingInr'],
        sourceAmount: amt(5, 100),
        exchangeRate: '83.5000',
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
      },
    }),
    REWARD_REDEMPTION: () => ({
      type: 'REWARD_REDEMPTION',
      effectiveDate: new Date().toISOString(),
      payload: {
        rewardsLiabilityAccountId: A['rewardsLiability'],
        walletAccountId: A['wallet'],
        pointsRedeemed: '150',
      },
    }),
    LOAN_DISBURSEMENT: () => ({
      type: 'LOAN_DISBURSEMENT',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        loanReceivableAccountId: A['loanReceivable'],
        gatewayExpenseAccountId: A['gatewayExpense'],
        principal: amt(5000, 50000),
        currency: 'INR',
        loanReference: 'LOAN-STRESS',
      },
    }),
    LOAN_EMI_PAYMENT: () => ({
      type: 'LOAN_EMI_PAYMENT',
      effectiveDate: new Date().toISOString(),
      payload: {
        walletAccountId: A['wallet'],
        loanReceivableAccountId: A['loanReceivable'],
        interestIncomeAccountId: A['interestIncome'],
        principalComponent: amt(500, 3000),
        interestComponent: amt(50, 400),
        currency: 'INR',
        emiNumber: '1',
        loanReference: 'LOAN-STRESS',
      },
    }),
    INTEREST_PAYOUT: () => ({
      type: 'INTEREST_PAYOUT',
      effectiveDate: new Date().toISOString(),
      payload: {
        interestPayableAccountId: A['interestPayable'],
        walletAccountId: A['wallet'],
        tdsPayableAccountId: A['tdsPayable'],
        grossInterest: amt(100, 2000),
        currency: 'INR',
        period: '2026-06',
      },
    }),
    CHARGEBACK: () => ({
      type: 'CHARGEBACK',
      effectiveDate: new Date().toISOString(),
      payload: {
        merchantSettlementAccountId: A['merchantSettlement'],
        walletAccountId: A['wallet'],
        chargebackFeeRevenueAccountId: A['chargebackFeeRevenue'],
        amount: amt(50, 500),
        currency: 'INR',
        disputeCode: 'DC-STRESS',
        arn: 'ARN-STRESS',
      },
    }),
  };

  const REPEATABLE_TYPES = Object.keys(generators) as TransactionType[];

  // ── Result tracking ────────────────────────────────────────────────────────
  const successCounts: Record<string, number> = {};
  const failureCounts: Record<string, number> = {};
  let attempted = 0;

  async function attempt(
    gen: () => { type: TransactionType; effectiveDate: string; payload: Record<string, unknown> },
  ): Promise<void> {
    attempted++;
    const dto = gen();
    try {
      await transactions.process(dto, 'stress-test', idem(), 'stress-test-user');
      successCounts[dto.type] = (successCounts[dto.type] ?? 0) + 1;
    } catch (error) {
      // Business-rule rejections (insufficient balance, validation) are EXPECTED
      // under randomised amounts — they prove the guards work, not a test failure.
      failureCounts[dto.type] = (failureCounts[dto.type] ?? 0) + 1;
      const msg = error instanceof Error ? error.message : String(error);
      const isExpected =
        msg.includes('Insufficient balance') ||
        msg.includes('exceeds') ||
        msg.includes('must be positive') ||
        msg.includes('is not active') ||
        msg.includes('cannot be negative');
      if (!isExpected) {
        // Truly unexpected error — rethrow so the test fails loudly
        throw new Error(`Unexpected failure on ${dto.type}: ${msg}`);
      }
    }
  }

  it('processes 1,000 randomised transactions across all 20 types with a perfect trial balance', async () => {
    // ── 780 iterations: random selection from the 16 self-sufficient types ──
    for (let i = 0; i < 780; i++) {
      const type = REPEATABLE_TYPES[Math.floor(Math.random() * REPEATABLE_TYPES.length)]!;
      await attempt(generators[type]!);
    }

    // ── 180 iterations: reversal-dependent types (need a fresh original txn) ─
    for (let i = 0; i < 180; i++) {
      attempted++;
      try {
        // Create a fresh merchant payment to reverse
        const original = await transactions.process(
          generators['MERCHANT_PAYMENT_QR']!(),
          'stress-test',
          idem(),
          'stress-test-user',
        );
        successCounts['MERCHANT_PAYMENT_QR'] = (successCounts['MERCHANT_PAYMENT_QR'] ?? 0) + 1;

        if (i % 2 === 0) {
          await reversals.reverseTransaction(
            { originalTransactionId: original.transactionId, reason: 'Stress test full reversal' },
            'stress-test',
            idem(),
          );
          successCounts['REFUND_FULL'] = (successCounts['REFUND_FULL'] ?? 0) + 1;
        } else {
          await reversals.partialRefund(
            {
              originalTransactionId: original.transactionId,
              refundAmount: '10.0000',
              feePolicy: 'PROPORTIONAL' as never,
              reason: 'Stress test partial refund',
            },
            'stress-test',
            idem(),
          );
          successCounts['REFUND_PARTIAL'] = (successCounts['REFUND_PARTIAL'] ?? 0) + 1;
        }
      } catch (error) {
        failureCounts['REVERSAL'] = (failureCounts['REVERSAL'] ?? 0) + 1;
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('Insufficient') && !msg.includes('exceeds')) {
          throw new Error(`Unexpected reversal failure: ${msg}`);
        }
      }
    }

    // ── 39 iterations of the CHARGEBACK type (already in generators map) ────
    for (let i = 0; i < 39; i++) {
      await attempt(generators['CHARGEBACK']!);
    }

    // ── Final: ACCOUNT_CLOSURE_SWEEP (1 iteration, uses live wallet balance) ─
    attempted++;
    const currentBalance = await ledger.getAccountBalance(A['wallet']!);
    if (parseFloat(currentBalance) > 0) {
      try {
        await transactions.process(
          {
            type: 'ACCOUNT_CLOSURE_SWEEP',
            effectiveDate: new Date().toISOString(),
            payload: {
              walletAccountId: A['wallet'],
              liabilityAccountId: A['liability'],
              amount: currentBalance,
              currency: 'INR',
              hasActiveLoan: false,
              bankReference: 'CLOSURE-STRESS',
            },
          },
          'stress-test',
          idem(),
          'stress-test-user',
        );
        successCounts['ACCOUNT_CLOSURE_SWEEP'] = 1;
      } catch (error) {
        failureCounts['ACCOUNT_CLOSURE_SWEEP'] = 1;
        throw error; // closure failure with exact balance IS unexpected
      }
    }

    // ── Assertions ────────────────────────────────────────────────────────────
    expect(attempted).toBe(1000);

    const totalSuccess = Object.values(successCounts).reduce((a, b) => a + b, 0);
    const totalFailure = Object.values(failureCounts).reduce((a, b) => a + b, 0);

    console.log('\n📊 Stress test summary:');
    console.log(`   Attempted: ${attempted.toString()}`);
    console.log(`   Succeeded: ${totalSuccess.toString()}`);
    console.log(`   Rejected (expected business rules): ${totalFailure.toString()}`);
    console.log('   Per-type success counts:', JSON.stringify(successCounts, null, 2));

    // All 20 transaction types must have been successfully exercised
    const exercisedTypes = new Set(Object.keys(successCounts));
    const allTypes: TransactionType[] = [
      'CUSTOMER_DEPOSIT_BANK',
      'CUSTOMER_DEPOSIT_CARD',
      'CUSTOMER_WITHDRAWAL_BANK',
      'P2P_TRANSFER',
      'MERCHANT_PAYMENT_QR',
      'MERCHANT_PAYMENT_ONLINE',
      'BILL_PAYMENT',
      'INTEREST_ACCRUAL',
      'INTEREST_PAYOUT',
      'FEE_DEDUCTION_MONTHLY',
      'CASHBACK_CREDIT',
      'PROMOTIONAL_CREDIT',
      'LOAN_DISBURSEMENT',
      'LOAN_EMI_PAYMENT',
      'FX_CONVERSION',
      'REFUND_FULL',
      'REFUND_PARTIAL',
      'CHARGEBACK',
      'REWARD_REDEMPTION',
      'ACCOUNT_CLOSURE_SWEEP',
    ];

    const missingTypes = allTypes.filter((t) => !exercisedTypes.has(t));
    expect(missingTypes).toEqual([]);

    // ── Trial balance must be perfectly balanced after 1,000 attempts ─────────
    const tb = await trialBalance.generate();
    expect(tb.isBalanced).toBe(true);
    expect(tb.discrepancy).toBe('0.0000');
    console.log(
      `\n✅ Trial balance: debits=${tb.grandTotalDebits} credits=${tb.grandTotalCredits} discrepancy=${tb.discrepancy}`,
    );

    // ── Hash chain must remain valid across every posted entry ────────────────
    const chainResult = await audit.verifyChain();
    expect(chainResult.chainResult.valid).toBe(true);
    console.log(
      `✅ Hash chain: valid=${chainResult.chainResult.valid.toString()} entries=${chainResult.chainResult.totalEntries.toString()}`,
    );
  });
});
