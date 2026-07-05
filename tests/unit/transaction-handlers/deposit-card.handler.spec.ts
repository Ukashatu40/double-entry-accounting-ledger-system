import { DepositCardHandler } from '@transactions/handlers/deposit-card.handler';
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

describe('DepositCardHandler', () => {
  let handler: DepositCardHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    liability: makeAccount({ id: 'liability-id' }),
    gatewayExpense: makeAccount({ id: 'gw-id' }),
    merchantPayable: makeAccount({ id: 'mp-id' }),
  };

  beforeEach(() => {
    handler = new DepositCardHandler();
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
    expect(() => validate({ amount: '1000.0000' }, accs)).toThrow('not active');
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('rejects an amount exceeding the card deposit limit', () => {
    expect(() => validate({ amount: '600000.0000' }, accounts)).toThrow('exceeds limit');
  });

  it('passes for a valid deposit', async () => {
    await expect(validate({ amount: '1000.0000' }, accounts)).resolves.not.toThrow();
  });
});
