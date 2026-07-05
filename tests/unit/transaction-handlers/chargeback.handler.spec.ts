import { ChargebackHandler } from '@transactions/handlers/chargeback.handler';
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

describe('ChargebackHandler', () => {
  let handler: ChargebackHandler;
  const accounts = {
    merchantSettlement: makeAccount({ id: 'merchant-id' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    chargebackFeeRevenue: makeAccount({ id: 'cbfee-id' }),
  };

  beforeEach(() => {
    handler = new ChargebackHandler();
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

  it('rejects a zero or negative chargeback amount', () => {
    expect(() => validate({ amount: '0.0000', disputeCode: 'DC1' }, accounts)).toThrow(
      'must be positive',
    );
  });

  it('rejects when no dispute code is provided', () => {
    expect(() => validate({ amount: '500.0000' }, accounts)).toThrow('disputeCode is required');
  });

  it('passes for a valid chargeback', async () => {
    await expect(
      validate({ amount: '500.0000', disputeCode: 'DC1' }, accounts),
    ).resolves.not.toThrow();
  });
});
