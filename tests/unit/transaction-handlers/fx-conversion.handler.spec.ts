import { FxConversionHandler } from '@transactions/handlers/fx-conversion.handler';
import type { FxRateService } from '@fx/fx-rate.service';
import type { Account, ExchangeRateSnapshot } from '@prisma/client';
import {
  assertJournalBalanced,
  assertAssetAccountMoves,
  assertCreditNormalAccountMoves,
} from './journal-entry-assertions.util';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    code: '1001',
    name: 'Test',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'INR',
    status: 'ACTIVE',
    parentId: null,
    description: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Account;
}

describe('FxConversionHandler', () => {
  let handler: FxConversionHandler;
  let fxRateService: jest.Mocked<FxRateService>;
  const accounts = {
    sourceWallet: makeAccount({ id: 'src-id' }),
    targetWallet: makeAccount({ id: 'tgt-id', currency: 'INR' }),
    fxRevenue: makeAccount({ id: 'fx-revenue-id', type: 'REVENUE' }),
    fxHoldingSource: makeAccount({ id: 'fx-holding-src-id' }),
    fxHoldingTarget: makeAccount({ id: 'fx-holding-tgt-id' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    fxRateService = { getCurrentRate: jest.fn() } as unknown as jest.Mocked<FxRateService>;
    handler = new FxConversionHandler(fxRateService);
  });

  function validate(payload: Record<string, unknown>, accs: typeof accounts) {
    return (
      handler as unknown as {
        validateBusinessRules: (
          p: Record<string, unknown>,
          a: Record<string, Account>,
        ) => Promise<void>;
      }
    ).validateBusinessRules(payload, accs);
  }

  it('rejects when the source wallet is not active', async () => {
    const accs = { ...accounts, sourceWallet: makeAccount({ id: 'src-id', status: 'INACTIVE' }) };
    await expect(
      validate({ sourceAmount: '100.0000', exchangeRate: '83.5' }, accs),
    ).rejects.toThrow('Source wallet');
  });

  it('rejects when the target wallet is not active', async () => {
    const accs = { ...accounts, targetWallet: makeAccount({ id: 'tgt-id', status: 'CLOSED' }) };
    await expect(
      validate({ sourceAmount: '100.0000', exchangeRate: '83.5' }, accs),
    ).rejects.toThrow('Target wallet');
  });

  it('rejects a zero or negative source amount', async () => {
    await expect(
      validate({ sourceAmount: '0.0000', exchangeRate: '83.5' }, accounts),
    ).rejects.toThrow('must be positive');
  });

  it('rejects a source amount exceeding the conversion limit', async () => {
    await expect(
      validate({ sourceAmount: '2000000.0000', exchangeRate: '83.5' }, accounts),
    ).rejects.toThrow('exceeds limit');
  });

  it('propagates a stale-rate rejection from FxRateService', async () => {
    fxRateService.getCurrentRate.mockRejectedValue(
      new Error('Exchange rate for USD/INR is stale: captured 90 minutes ago'),
    );
    await expect(
      validate(
        {
          sourceAmount: '100.0000',
          exchangeRate: '83.5',
          sourceCurrency: 'USD',
          targetCurrency: 'INR',
        },
        accounts,
      ),
    ).rejects.toThrow('is stale');
  });

  it('passes when the rate service confirms a fresh rate', async () => {
    fxRateService.getCurrentRate.mockResolvedValue({} as ExchangeRateSnapshot);
    await expect(
      validate({ sourceAmount: '100.0000', exchangeRate: '83.5' }, accounts),
    ).resolves.not.toThrow();
  });

  it('rejects an unsupported sourceCurrency (regression test for the currency-validation retrofit)', async () => {
    await expect(
      validate(
        { sourceAmount: '100.0000', exchangeRate: '83.5', sourceCurrency: 'ZZZ' },
        accounts,
      ),
    ).rejects.toThrow('Unsupported currency: ZZZ');
  });

  it('rejects an unsupported targetCurrency', async () => {
    await expect(
      validate(
        { sourceAmount: '100.0000', exchangeRate: '83.5', targetCurrency: 'ZZZ' },
        accounts,
      ),
    ).rejects.toThrow('Unsupported currency: ZZZ');
  });

  describe('buildJournalEntry', () => {
    function build(payload: Record<string, unknown>) {
      return (
        handler as unknown as {
          buildJournalEntry: (
            id: string,
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => {
            lines: Array<{ accountId: string; entryType: 'DEBIT' | 'CREDIT'; amount: string }>;
          };
        }
      ).buildJournalEntry('txn-1', payload, accounts);
    }

    const payload = {
      sourceAmount: '100.0000',
      exchangeRate: '83.5000',
      sourceCurrency: 'USD',
      targetCurrency: 'INR',
    };

    it('produces a fully balanced journal entry', () => {
      const dto = build(payload);
      assertJournalBalanced(dto.lines);
    });

    it('CREDITs fxRevenue (regression test for the fixed polarity bug — revenue must increase, not decrease)', () => {
      const dto = build(payload);
      const revenueLine = dto.lines.find((l) => l.accountId === 'fx-revenue-id');
      expect(revenueLine?.entryType).toBe('CREDIT');
      assertCreditNormalAccountMoves(dto.lines, 'fx-revenue-id', 'increase');
    });

    it('DECREASES the source wallet balance', () => {
      const dto = build(payload);
      assertAssetAccountMoves(dto.lines, 'src-id', 'decrease');
    });

    it('INCREASES the target wallet balance by grossTarget minus the markup', () => {
      const dto = build(payload);
      assertAssetAccountMoves(dto.lines, 'tgt-id', 'increase');
      const targetLine = dto.lines.find((l) => l.accountId === 'tgt-id');
      // grossTarget = 100 * 83.5 = 8350.0000; markup = 0.5% = 41.7500
      expect(targetLine?.amount).toBe('8308.2500');
    });

    it('plugs the residual on platformOperatingCash (see ADR-007)', () => {
      const dto = build(payload);
      const plugLine = dto.lines.find((l) => l.accountId === 'platform-id');
      expect(plugLine).toBeDefined();
      expect(plugLine?.entryType).toBe('DEBIT');
      // residual = 2 x markup = 2 x 41.7500 = 83.5000
      expect(plugLine?.amount).toBe('83.5000');
    });
  });

  describe('getLimitCheckSpecs', () => {
    it('checks the source wallet against sourceAmount', () => {
      const result = (
        handler as unknown as {
          getLimitCheckSpecs: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => { accountId: string; amount: string }[];
        }
      ).getLimitCheckSpecs({ sourceAmount: '100.0000' }, accounts);
      expect(result).toEqual([{ accountId: 'src-id', amount: '100.0000' }]);
    });
  });
});
