import { FeeDeductionHandler } from '@transactions/handlers/fee-deduction.handler';
import type { Account } from '@prisma/client';

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

describe('FeeDeductionHandler', () => {
  let handler: FeeDeductionHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    feeRevenue: makeAccount({ id: 'fee-id' }),
  };

  beforeEach(() => {
    handler = new FeeDeductionHandler();
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

  it('rejects when the wallet is not active', () => {
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'INACTIVE' }) };
    expect(() => validate({ amount: '50.0000' }, accs)).toThrow('is not active');
  });

  it('rejects a zero or negative fee amount', () => {
    expect(() => validate({ amount: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('passes for a valid fee deduction', async () => {
    await expect(validate({ amount: '50.0000' }, accounts)).resolves.not.toThrow();
  });
});
