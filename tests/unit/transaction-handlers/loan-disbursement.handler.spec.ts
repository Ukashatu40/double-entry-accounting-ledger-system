import { LoanDisbursementHandler } from '@transactions/handlers/loan-disbursement.handler';
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

describe('LoanDisbursementHandler', () => {
  let handler: LoanDisbursementHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    loanReceivable: makeAccount({ id: 'loan-id' }),
    gatewayExpense: makeAccount({ id: 'gw-id' }),
  };

  beforeEach(() => {
    handler = new LoanDisbursementHandler();
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
    expect(() => validate({ principal: '10000.0000' }, accs)).toThrow('not active');
  });

  it('rejects a zero or negative principal', () => {
    expect(() => validate({ principal: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('rejects a principal exceeding the maximum loan amount', () => {
    expect(() => validate({ principal: '6000000.0000' }, accounts)).toThrow('exceeds maximum');
  });

  it('passes for a valid loan disbursement', async () => {
    await expect(validate({ principal: '10000.0000' }, accounts)).resolves.not.toThrow();
  });
});
