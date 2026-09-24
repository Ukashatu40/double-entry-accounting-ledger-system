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
    penaltyRevenue: makeAccount({ id: 'penalty-id', type: 'REVENUE', code: '4020' }),
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
      validate({ scheduledPrincipal: '500.0000', scheduledInterest: '50.0000' }, accs),
    ).toThrow('Customer wallet');
  });

  it('rejects an unsupported currency code (regression test for the currency-validation retrofit)', () => {
    expect(() =>
      validate(
        { scheduledPrincipal: '500.0000', scheduledInterest: '50.0000', currency: 'ZZZ' },
        accounts,
      ),
    ).toThrow('Unsupported currency');
  });

  it('rejects a negative principal component', () => {
    expect(() =>
      validate({ scheduledPrincipal: '-100.0000', scheduledInterest: '50.0000' }, accounts),
    ).toThrow('Principal component cannot be negative');
  });

  it('rejects a negative interest component', () => {
    expect(() =>
      validate({ scheduledPrincipal: '500.0000', scheduledInterest: '-10.0000' }, accounts),
    ).toThrow('Interest component cannot be negative');
  });

  it('rejects when both components sum to zero', () => {
    expect(() =>
      validate({ scheduledPrincipal: '0.0000', scheduledInterest: '0.0000' }, accounts),
    ).toThrow('EMI amount must be positive');
  });

  it('rejects a paymentAmount that falls short of the full amount due (penalty + interest + principal)', () => {
    expect(() =>
      validate(
        {
          scheduledPrincipal: '500.0000',
          scheduledInterest: '50.0000',
          daysOverdue: 10,
          paymentAmount: '500.0000', // short of the 555.50 actually due
        },
        accounts,
      ),
    ).toThrow('less than the full amount due');
  });

  it('passes for a valid on-time EMI payment', async () => {
    await expect(
      validate({ scheduledPrincipal: '500.0000', scheduledInterest: '50.0000' }, accounts),
    ).resolves.not.toThrow();
  });

  it('passes for a valid overdue payment that exactly covers principal + interest + penalty', async () => {
    await expect(
      validate(
        {
          scheduledPrincipal: '500.0000',
          scheduledInterest: '50.0000',
          daysOverdue: 10,
          paymentAmount: '555.5000',
        },
        accounts,
      ),
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

    it('produces a fully balanced journal entry for an on-time payment, with no penalty line', () => {
      const dto = build({ scheduledPrincipal: '8000.0000', scheduledInterest: '1603.0000' });
      assertJournalBalanced(dto.lines);
      expect(dto.lines.find((l) => l.accountId === 'penalty-id')).toBeUndefined();

      const walletLine = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(walletLine?.amount).toBe('9603.0000');
      const principalLine = dto.lines.find((l) => l.accountId === 'loan-id');
      expect(principalLine?.amount).toBe('8000.0000');
      const interestLine = dto.lines.find((l) => l.accountId === 'interest-id');
      expect(interestLine?.amount).toBe('1603.0000');
    });

    it('DECREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ scheduledPrincipal: '8000.0000', scheduledInterest: '1603.0000' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'decrease');
    });

    it('DECREASES the loan receivable balance (principal paid down)', () => {
      const dto = build({ scheduledPrincipal: '8000.0000', scheduledInterest: '1603.0000' });
      assertAssetAccountMoves(dto.lines, 'loan-id', 'decrease');
    });

    it('applies an overdue penalty via the penalty→interest→principal waterfall (regression test for Scenario 3)', () => {
      const dto = build({
        scheduledPrincipal: '8000.0000',
        scheduledInterest: '1603.0000',
        daysOverdue: 5,
      });
      assertJournalBalanced(dto.lines);

      // penalty = (8000+1603) * 0.001 * 5 = 48.0150
      const penaltyLine = dto.lines.find((l) => l.accountId === 'penalty-id');
      expect(penaltyLine?.entryType).toBe('CREDIT');
      expect(penaltyLine?.amount).toBe('48.0150');

      // paymentAmount defaults to totalDue = 9603 + 48.015 = 9651.0150,
      // fully covers scheduled interest and principal after the penalty
      const walletLine = dto.lines.find((l) => l.accountId === 'wallet-id');
      expect(walletLine?.amount).toBe('9651.0150');
      const interestLine = dto.lines.find((l) => l.accountId === 'interest-id');
      expect(interestLine?.amount).toBe('1603.0000');
      const principalLine = dto.lines.find((l) => l.accountId === 'loan-id');
      expect(principalLine?.amount).toBe('8000.0000');
    });

    it('applies a prepayment surplus entirely as extra principal paydown', () => {
      const dto = build({
        scheduledPrincipal: '8000.0000',
        scheduledInterest: '1603.0000',
        daysOverdue: 5,
        paymentAmount: '10651.0150', // totalDue (9651.0150) + 1000 extra
      });
      assertJournalBalanced(dto.lines);

      const principalLine = dto.lines.find((l) => l.accountId === 'loan-id');
      expect(principalLine?.amount).toBe('9000.0000'); // 8000 scheduled + 1000 prepaid
      const interestLine = dto.lines.find((l) => l.accountId === 'interest-id');
      expect(interestLine?.amount).toBe('1603.0000'); // interest never absorbs surplus
      const penaltyLine = dto.lines.find((l) => l.accountId === 'penalty-id');
      expect(penaltyLine?.amount).toBe('48.0150'); // penalty never absorbs surplus either
    });
  });

  describe('getLimitCheckSpecs', () => {
    it('checks the wallet against the total payment amount (principal + interest, on-time)', () => {
      const result = (
        handler as unknown as {
          getLimitCheckSpecs: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => { accountId: string; amount: string }[];
        }
      ).getLimitCheckSpecs(
        { scheduledPrincipal: '8000.0000', scheduledInterest: '1603.0000' },
        accounts,
      );
      expect(result).toEqual([{ accountId: 'wallet-id', amount: '9603.0000' }]);
    });

    it('includes the overdue penalty in the checked amount', () => {
      const result = (
        handler as unknown as {
          getLimitCheckSpecs: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => { accountId: string; amount: string }[];
        }
      ).getLimitCheckSpecs(
        { scheduledPrincipal: '8000.0000', scheduledInterest: '1603.0000', daysOverdue: 5 },
        accounts,
      );
      expect(result).toEqual([{ accountId: 'wallet-id', amount: '9651.0150' }]);
    });
  });
});
