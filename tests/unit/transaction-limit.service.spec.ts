// tests/unit/transaction-limit.service.spec.ts
import { TransactionLimitService } from '@ledger/transaction-limit.service';
import { DatabaseService } from '@database/database.service';
import Decimal from 'decimal.js';

function makeMockDb(
  limit: {
    maxPerTx: string | null;
    maxPerDay: string | null;
    maxPerMonth: string | null;
    isActive: boolean;
  } | null,
  sumResult: string = '0',
): DatabaseService {
  const mock = {
    transactionLimit: {
      findUnique: jest.fn().mockResolvedValue(
        limit === null
          ? null
          : {
              ...limit,
              maxPerTx: limit.maxPerTx === null ? null : { toString: () => limit.maxPerTx },
              maxPerDay: limit.maxPerDay === null ? null : { toString: () => limit.maxPerDay },
              maxPerMonth:
                limit.maxPerMonth === null ? null : { toString: () => limit.maxPerMonth },
            },
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ total: sumResult }]),
  };
  return mock as unknown as DatabaseService;
}

describe('TransactionLimitService', () => {
  it('passes through when no TransactionLimit row exists for the account+type', async () => {
    const db = makeMockDb(null);
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('1000000.0000')),
    ).resolves.not.toThrow();
  });

  it('passes through when the limit row is inactive', async () => {
    const db = makeMockDb({
      maxPerTx: '100.0000',
      maxPerDay: null,
      maxPerMonth: null,
      isActive: false,
    });
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('1000.0000')),
    ).resolves.not.toThrow();
  });

  it('rejects an amount exceeding maxPerTx', async () => {
    const db = makeMockDb({
      maxPerTx: '50000.0000',
      maxPerDay: null,
      maxPerMonth: null,
      isActive: true,
    });
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('50000.0001')),
    ).rejects.toThrow('exceeds per-transaction limit');
  });

  it('allows an amount exactly at maxPerTx', async () => {
    const db = makeMockDb({
      maxPerTx: '50000.0000',
      maxPerDay: null,
      maxPerMonth: null,
      isActive: true,
    });
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('50000.0000')),
    ).resolves.not.toThrow();
  });

  it('rejects when the amount would push the daily total over maxPerDay', async () => {
    const db = makeMockDb(
      { maxPerTx: null, maxPerDay: '50000.0000', maxPerMonth: null, isActive: true },
      '49000.0000', // already posted today
    );
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('2000.0000')),
    ).rejects.toThrow('would exceed daily limit');
  });

  it('rejects when the amount would push the monthly total over maxPerMonth', async () => {
    const db = makeMockDb(
      { maxPerTx: null, maxPerDay: null, maxPerMonth: '200000.0000', isActive: true },
      '199000.0000', // already posted this month
    );
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('5000.0000')),
    ).rejects.toThrow('would exceed monthly limit');
  });

  it('a TIER_3-shaped row (all null) never rejects, regardless of amount', async () => {
    const db = makeMockDb({
      maxPerTx: null,
      maxPerDay: null,
      maxPerMonth: null,
      isActive: true,
    });
    const service = new TransactionLimitService(db);
    await expect(
      service.assertWithinLimits('acc-1', 'NIP_TRANSFER', new Decimal('99999999.0000')),
    ).resolves.not.toThrow();
  });
});
