import { PromotionalCreditHandler } from '@transactions/handlers/promotional-credit.handler';
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

describe('PromotionalCreditHandler', () => {
  let handler: PromotionalCreditHandler;
  const accounts = {
    cashbackExpense: makeAccount({ id: 'cb-id' }),
    wallet: makeAccount({ id: 'wallet-id' }),
  };

  beforeEach(() => {
    handler = new PromotionalCreditHandler();
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
    expect(() => validate({ amount: '50.0000', promoCode: 'PROMO1' }, accs)).toThrow('not active');
  });

  it('rejects when no promo code is provided', () => {
    expect(() => validate({ amount: '50.0000' }, accounts)).toThrow('promoCode is required');
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000', promoCode: 'PROMO1' }, accounts)).toThrow(
      'must be positive',
    );
  });

  it('passes for a valid promotional credit', async () => {
    await expect(
      validate({ amount: '50.0000', promoCode: 'PROMO1' }, accounts),
    ).resolves.not.toThrow();
  });
});
