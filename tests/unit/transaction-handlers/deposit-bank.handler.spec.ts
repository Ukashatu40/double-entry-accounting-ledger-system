import { DepositBankHandler } from '@transactions/handlers/deposit-bank.handler';
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

describe('DepositBankHandler', () => {
  let handler: DepositBankHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    liability: makeAccount({ id: 'liability-id' }),
  };

  beforeEach(() => {
    handler = new DepositBankHandler();
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

  it('rejects when the wallet account is not active', () => {
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'INACTIVE' }) };
    expect(() => validate({ amount: '1000.0000' }, accs)).toThrow('is not active');
  });

  it('rejects when the deposit amount exceeds the single-transaction limit', () => {
    expect(() => validate({ amount: '2000000.0000' }, accounts)).toThrow(
      'exceeds single-transaction limit',
    );
  });

  it('rejects an unsupported currency code (regression test for the currency-validation retrofit)', () => {
    expect(() => validate({ amount: '5000.0000', currency: 'ZZZ' }, accounts)).toThrow(
      'Unsupported currency',
    );
  });

  it('passes for a valid active wallet and amount within limits', async () => {
    await expect(validate({ amount: '5000.0000' }, accounts)).resolves.not.toThrow();
  });

  describe('getBalanceCheckAccounts', () => {
    it('returns an empty array — deposits never require a balance check', () => {
      const result = (
        handler as unknown as { getBalanceCheckAccounts: () => string[] }
      ).getBalanceCheckAccounts();
      expect(result).toEqual([]);
    });
  });
});
