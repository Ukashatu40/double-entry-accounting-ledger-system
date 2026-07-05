import { FxConversionHandler } from '@transactions/handlers/fx-conversion.handler';
import type { FxRateService } from '@fx/fx-rate.service';
import type { Account, ExchangeRateSnapshot } from '@prisma/client';

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
    targetWallet: makeAccount({ id: 'tgt-id' }),
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

  it('rejects a zero or negative exchange rate', async () => {
    await expect(
      validate({ sourceAmount: '100.0000', exchangeRate: '0' }, accounts),
    ).rejects.toThrow('Exchange rate must be positive');
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
});
