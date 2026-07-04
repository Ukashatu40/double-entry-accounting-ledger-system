// tests/unit/transaction-handlers/refund-partial.handler.spec.ts
// import { UnprocessableEntityException } from '@nestjs/common';
import { RefundPartialHandler } from '@transactions/handlers/refund-partial.handler';
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

describe('RefundPartialHandler', () => {
  let handler: RefundPartialHandler;

  const validAccounts = {
    merchantSettlement: makeAccount({ id: 'merchant-id' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    feeRevenue: makeAccount({ id: 'fee-id' }),
  };

  beforeEach(() => {
    handler = new RefundPartialHandler();
  });

  function validate(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    return (
      handler as unknown as {
        validateBusinessRules: (
          p: Record<string, unknown>,
          a: Record<string, Account>,
        ) => Promise<void>;
      }
    ).validateBusinessRules(payload, accounts);
  }

  describe('validateBusinessRules', () => {
    it('passes for a valid refund within the original amount', async () => {
      await expect(
        validate(
          { refundAmount: '500.0000', originalAmount: '1000.0000', feePolicy: 'PROPORTIONAL' },
          validAccounts,
        ),
      ).resolves.not.toThrow();
    });

    it('rejects a refund amount that is zero or negative', () => {
      expect(() =>
        validate(
          { refundAmount: '0.0000', originalAmount: '1000.0000', feePolicy: 'NONE' },
          validAccounts,
        ),
      ).toThrow('Refund amount must be positive');
    });

    it('rejects a refund amount exceeding the original transaction amount', () => {
      expect(() =>
        validate(
          { refundAmount: '1500.0000', originalAmount: '1000.0000', feePolicy: 'NONE' },
          validAccounts,
        ),
      ).toThrow('exceeds original');
    });

    it('rejects an invalid fee policy string', () => {
      expect(() =>
        validate(
          { refundAmount: '500.0000', originalAmount: '1000.0000', feePolicy: 'BOGUS' },
          validAccounts,
        ),
      ).toThrow('Invalid fee policy');
    });
  });

  describe('buildJournalEntry — fee policy math', () => {
    function build(
      feePolicy: string,
      refundAmount: string,
      originalAmount: string,
      originalFee: string,
    ) {
      return (
        handler as unknown as {
          buildJournalEntry: (
            id: string,
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => {
            lines: Array<{ accountId: string; entryType: string; amount: string }>;
          };
        }
      ).buildJournalEntry(
        'txn-id',
        {
          refundAmount,
          originalAmount,
          originalFee,
          feePolicy,
          currency: 'INR',
          originalTransactionId: 'orig-id',
        },
        validAccounts,
      );
    }

    it('PROPORTIONAL policy refunds fee in proportion to refund amount', () => {
      // (500/1000) * 20 = 10.0000
      const dto = build('PROPORTIONAL', '500.0000', '1000.0000', '20.0000');
      const debits = dto.lines
        .filter((l) => l.entryType === 'DEBIT')
        .reduce((s, l) => s + parseFloat(l.amount), 0);
      const credits = dto.lines
        .filter((l) => l.entryType === 'CREDIT')
        .reduce((s, l) => s + parseFloat(l.amount), 0);
      expect(debits).toBeCloseTo(credits, 4);

      const walletCredit = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(parseFloat(walletCredit!.amount)).toBeCloseTo(510, 4); // 500 + 10 proportional fee
    });

    it('FULL policy refunds the entire original fee regardless of partial amount', () => {
      const dto = build('FULL', '500.0000', '1000.0000', '20.0000');
      const walletCredit = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(parseFloat(walletCredit!.amount)).toBeCloseTo(520, 4); // 500 + full 20 fee
    });

    it('NONE policy retains the fee — customer receives only the refund amount', () => {
      const dto = build('NONE', '500.0000', '1000.0000', '20.0000');
      const walletCredit = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(parseFloat(walletCredit!.amount)).toBeCloseTo(500, 4);
      // No fee reversal line should exist under NONE policy
      expect(dto.lines).toHaveLength(2);
    });

    it('always produces a balanced journal entry across all three policies', () => {
      for (const policy of ['PROPORTIONAL', 'FULL', 'NONE']) {
        const dto = build(policy, '300.0000', '1000.0000', '15.0000');
        const debits = dto.lines
          .filter((l) => l.entryType === 'DEBIT')
          .reduce((s, l) => s + parseFloat(l.amount), 0);
        const credits = dto.lines
          .filter((l) => l.entryType === 'CREDIT')
          .reduce((s, l) => s + parseFloat(l.amount), 0);
        expect(debits).toBeCloseTo(credits, 4);
      }
    });
  });

  describe('getBalanceCheckAccounts', () => {
    it('returns an empty array — partial refunds never require a balance check', () => {
      const result = (
        handler as unknown as { getBalanceCheckAccounts: () => string[] }
      ).getBalanceCheckAccounts();
      expect(result).toEqual([]);
    });
  });
});
