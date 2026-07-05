import { MerchantPaymentOnlineHandler } from '@transactions/handlers/merchant-payment-online.handler';
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

describe('MerchantPaymentOnlineHandler', () => {
  let handler: MerchantPaymentOnlineHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    merchant: makeAccount({ id: 'merchant-id' }),
    feeRevenue: makeAccount({ id: 'fee-id' }),
  };

  beforeEach(() => {
    handler = new MerchantPaymentOnlineHandler();
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
    expect(() => validate({ amount: '500.0000' }, accs)).toThrow('not active');
  });

  it('rejects when the merchant is not active', () => {
    const accs = { ...accounts, merchant: makeAccount({ id: 'merchant-id', status: 'INACTIVE' }) };
    expect(() => validate({ amount: '500.0000' }, accs)).toThrow('Merchant settlement account');
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('rejects an amount exceeding the online payment limit', () => {
    expect(() => validate({ amount: '600000.0000' }, accounts)).toThrow(
      'exceeds online payment limit',
    );
  });

  it('passes for a valid online payment', async () => {
    await expect(validate({ amount: '500.0000' }, accounts)).resolves.not.toThrow();
  });
});
