// tests/unit/transaction-handlers/loan-emi-payment.handler.spec.ts
import { LoanEmiPaymentHandler } from '@transactions/handlers/loan-emi-payment.handler';
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

describe('LoanEmiPaymentHandler', () => {
  let handler: LoanEmiPaymentHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    loanReceivable: makeAccount({ id: 'loan-id' }),
    interestIncome: makeAccount({ id: 'interest-id' }),
  };

  beforeEach(() => {
    handler = new LoanEmiPaymentHandler();
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
    expect(() =>
      validate({ principalComponent: '500.0000', interestComponent: '50.0000' }, accs),
    ).toThrow('Customer wallet');
  });

  it('rejects a negative principal component', () => {
    expect(() =>
      validate({ principalComponent: '-100.0000', interestComponent: '50.0000' }, accounts),
    ).toThrow('Principal component cannot be negative');
  });

  it('rejects a negative interest component', () => {
    expect(() =>
      validate({ principalComponent: '500.0000', interestComponent: '-10.0000' }, accounts),
    ).toThrow('Interest component cannot be negative');
  });

  it('rejects when both components sum to zero', () => {
    expect(() =>
      validate({ principalComponent: '0.0000', interestComponent: '0.0000' }, accounts),
    ).toThrow('EMI amount must be positive');
  });

  it('passes for a valid EMI split', async () => {
    await expect(
      validate({ principalComponent: '500.0000', interestComponent: '50.0000' }, accounts),
    ).resolves.not.toThrow();
  });
});
