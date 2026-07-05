import { CashbackCreditHandler } from '@transactions/handlers/cashback-credit.handler';
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

describe('CashbackCreditHandler', () => {
  let handler: CashbackCreditHandler;
  const accounts = {
    cashbackExpense: makeAccount({ id: 'cb-id' }),
    wallet: makeAccount({ id: 'wallet-id' }),
  };

  beforeEach(() => {
    handler = new CashbackCreditHandler();
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
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'CLOSED' }) };
    expect(() => validate({ amount: '50.0000' }, accs)).toThrow('not active');
  });

  it('rejects a zero or negative cashback amount', () => {
    expect(() => validate({ amount: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('rejects an amount exceeding the per-transaction cap', () => {
    expect(() => validate({ amount: '20000.0000' }, accounts)).toThrow(
      'exceeds per-transaction cap',
    );
  });

  it('passes for a valid cashback credit', async () => {
    await expect(validate({ amount: '50.0000' }, accounts)).resolves.not.toThrow();
  });
});
