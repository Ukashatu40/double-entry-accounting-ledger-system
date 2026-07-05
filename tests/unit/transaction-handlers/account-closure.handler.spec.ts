import { AccountClosureHandler } from '@transactions/handlers/account-closure.handler';
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

describe('AccountClosureHandler', () => {
  let handler: AccountClosureHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    liability: makeAccount({ id: 'liability-id' }),
  };

  beforeEach(() => {
    handler = new AccountClosureHandler();
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

  it('rejects when the account is already closed', () => {
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'CLOSED' }) };
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('already closed');
  });

  it('rejects closure when the account has an active loan', () => {
    expect(() => validate({ amount: '100.0000', hasActiveLoan: true }, accounts)).toThrow(
      'active loan',
    );
  });

  it('rejects a negative sweep amount', () => {
    expect(() => validate({ amount: '-50.0000' }, accounts)).toThrow('cannot be negative');
  });

  it('passes for a valid closure sweep', async () => {
    await expect(validate({ amount: '100.0000' }, accounts)).resolves.not.toThrow();
  });

  it('buildJournalEntry rejects when the sweep amount is exactly zero', () => {
    expect(() =>
      (
        handler as unknown as {
          buildJournalEntry: (
            id: string,
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => unknown;
        }
      ).buildJournalEntry('txn-1', { amount: '0.0000' }, accounts),
    ).toThrow('already zero');
  });
});
