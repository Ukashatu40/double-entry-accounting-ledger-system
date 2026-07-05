import { WithdrawalHandler } from '@transactions/handlers/withdrawal.handler';
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

describe('WithdrawalHandler', () => {
  let handler: WithdrawalHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    liability: makeAccount({ id: 'liability-id' }),
  };

  beforeEach(() => {
    handler = new WithdrawalHandler();
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
    expect(() => validate({ amount: '500.0000' }, accs)).toThrow('not active');
  });

  it('rejects when the withdrawal exceeds the daily limit', () => {
    expect(() => validate({ amount: '200000.0000' }, accounts)).toThrow('exceeds daily limit');
  });

  it('passes for a valid withdrawal', async () => {
    await expect(validate({ amount: '500.0000' }, accounts)).resolves.not.toThrow();
  });

  describe('getBalanceCheckAccounts', () => {
    it('returns the wallet id for the balance check', () => {
      const result = (
        handler as unknown as {
          getBalanceCheckAccounts: (p: unknown, a: Record<string, Account>) => string[];
        }
      ).getBalanceCheckAccounts({}, accounts);
      expect(result).toEqual(['wallet-id']);
    });
  });
});
