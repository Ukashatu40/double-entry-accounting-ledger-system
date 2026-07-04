// tests/unit/transaction-handlers/refund-full.handler.spec.ts — corrected file
import { UnprocessableEntityException } from '@nestjs/common';
import { RefundFullHandler } from '@transactions/handlers/refund-full.handler';
import type { Account } from '@prisma/client';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-id',
    code: '0000',
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

type Validator = (p: Record<string, unknown>, a: Record<string, Account>) => Promise<void>;
type Builder = (
  id: string,
  p: Record<string, unknown>,
  a: Record<string, Account>,
) => {
  lines: Array<{ accountId: string; entryType: string; amount: string }>;
};

describe('RefundFullHandler', () => {
  let handler: RefundFullHandler;

  beforeEach(() => {
    handler = new RefundFullHandler();
  });

  const validAccounts = {
    merchantSettlement: makeAccount({ id: 'merchant-id', status: 'ACTIVE' }),
    wallet: makeAccount({ id: 'wallet-id', status: 'ACTIVE' }),
    feeRevenue: makeAccount({ id: 'fee-id', status: 'ACTIVE' }),
  };

  function validate(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    return (handler as unknown as { validateBusinessRules: Validator }).validateBusinessRules(
      payload,
      accounts,
    );
  }

  describe('validateBusinessRules', () => {
    it('passes for a valid active merchant, wallet, and positive amount', async () => {
      await expect(validate({ amount: '500.0000' }, validAccounts)).resolves.not.toThrow();
    });

    it('rejects when merchant settlement account is not active', () => {
      const accounts = {
        ...validAccounts,
        merchantSettlement: makeAccount({ status: 'INACTIVE' }),
      };
      expect(() => validate({ amount: '500.0000' }, accounts)).toThrow(
        UnprocessableEntityException,
      );
    });

    it('rejects when wallet is closed', () => {
      const accounts = { ...validAccounts, wallet: makeAccount({ status: 'CLOSED' }) };
      expect(() => validate({ amount: '500.0000' }, accounts)).toThrow(
        'Cannot refund to a closed wallet',
      );
    });

    it('rejects a zero or negative amount', () => {
      expect(() => validate({ amount: '0.0000' }, validAccounts)).toThrow(
        'Refund amount must be positive',
      );
    });
  });

  describe('buildJournalEntry', () => {
    it('produces a balanced journal entry including the fee reversal', () => {
      const dto = (handler as unknown as { buildJournalEntry: Builder }).buildJournalEntry(
        'txn-id',
        {
          amount: '1000.0000',
          feeAmount: '20.0000',
          currency: 'INR',
          originalTransactionId: 'orig-id',
          reason: 'Test',
        },
        validAccounts,
      );
      const debits = dto.lines
        .filter((l) => l.entryType === 'DEBIT')
        .reduce((s, l) => s + parseFloat(l.amount), 0);
      const credits = dto.lines
        .filter((l) => l.entryType === 'CREDIT')
        .reduce((s, l) => s + parseFloat(l.amount), 0);
      expect(debits).toBeCloseTo(credits, 4);
      expect(dto.lines).toHaveLength(3);
    });

    it('defaults feeAmount to 0 when not provided', () => {
      const dto = (handler as unknown as { buildJournalEntry: Builder }).buildJournalEntry(
        'txn-id',
        { amount: '1000.0000', currency: 'INR', originalTransactionId: 'orig-id' },
        validAccounts,
      );
      const walletLine = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(walletLine?.amount).toBe('1000.0000');
    });
  });

  describe('getBalanceCheckAccounts', () => {
    it('returns an empty array — full refunds never require a balance check', () => {
      const result = (
        handler as unknown as { getBalanceCheckAccounts: () => string[] }
      ).getBalanceCheckAccounts();
      expect(result).toEqual([]);
    });
  });
});
