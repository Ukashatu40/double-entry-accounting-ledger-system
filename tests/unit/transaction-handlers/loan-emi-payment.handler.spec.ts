// tests/unit/transaction-handlers/loan-emi-payment.handler.spec.ts
import { LoanEmiPaymentHandler } from '@transactions/handlers/loan-emi-payment.handler';
import type { Account } from '@prisma/client';
import { assertJournalBalanced, assertAssetAccountMoves } from './journal-entry-assertions.util';

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
    interestIncome: makeAccount({ id: 'interest-id', type: 'REVENUE' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
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

  describe('buildJournalEntry — balance and direction', () => {
    function build(payload: Record<string, unknown>) {
      return (
        handler as unknown as {
          buildJournalEntry: (
            id: string,
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => {
            lines: Array<{ accountId: string; entryType: 'DEBIT' | 'CREDIT'; amount: string }>;
          };
        }
      ).buildJournalEntry('txn-1', payload, accounts);
    }

    it('produces a fully balanced journal entry', () => {
      const dto = build({ principalComponent: '8000.0000', interestComponent: '1603.0000' });
      assertJournalBalanced(dto.lines);
    });

    it('DECREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ principalComponent: '8000.0000', interestComponent: '1603.0000' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'decrease');
    });

    it('DECREASES the loan receivable balance (principal paid down)', () => {
      const dto = build({ principalComponent: '8000.0000', interestComponent: '1603.0000' });
      assertAssetAccountMoves(dto.lines, 'loan-id', 'decrease');
    });
  });

  describe('getLimitCheckSpecs', () => {
    it('checks the wallet against the total EMI (principal + interest)', () => {
      const result = (
        handler as unknown as {
          getLimitCheckSpecs: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => { accountId: string; amount: string }[];
        }
      ).getLimitCheckSpecs(
        { principalComponent: '8000.0000', interestComponent: '1603.0000' },
        accounts,
      );
      expect(result).toEqual([{ accountId: 'wallet-id', amount: '9603.0000' }]);
    });
  });
});
