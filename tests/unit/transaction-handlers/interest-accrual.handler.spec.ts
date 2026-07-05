import { InterestAccrualHandler } from '@transactions/handlers/interest-accrual.handler';
import type { Account } from '@prisma/client';

describe('InterestAccrualHandler', () => {
  let handler: InterestAccrualHandler;

  beforeEach(() => {
    handler = new InterestAccrualHandler();
  });

  function validate(payload: Record<string, unknown>) {
    return (
      handler as unknown as {
        validateBusinessRules: (
          p: Record<string, unknown>,
          a: Record<string, Account>,
        ) => Promise<void>;
      }
    ).validateBusinessRules(payload, {});
  }

  it('rejects a zero or negative principal', () => {
    expect(() => validate({ principal: '0.0000', annualRate: '0.04' })).toThrow(
      'Principal must be positive',
    );
  });

  it('rejects an annual rate of zero', () => {
    expect(() => validate({ principal: '100000.0000', annualRate: '0' })).toThrow(
      'Annual rate must be between 0 and 1',
    );
  });

  it('rejects an annual rate above 1 (100%)', () => {
    expect(() => validate({ principal: '100000.0000', annualRate: '1.5' })).toThrow(
      'Annual rate must be between 0 and 1',
    );
  });

  it('passes for a valid principal and rate', async () => {
    await expect(validate({ principal: '100000.0000', annualRate: '0.04' })).resolves.not.toThrow();
  });

  it('rejects when the computed daily interest rounds to zero', () => {
    const accounts = {
      interestExpense: { id: 'ie-id' } as Account,
      interestPayable: { id: 'ip-id' } as Account,
    };
    expect(() =>
      (
        handler as unknown as {
          buildJournalEntry: (
            id: string,
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => unknown;
        }
      ).buildJournalEntry('txn-1', { principal: '1.0000', annualRate: '0.0001' }, accounts),
    ).toThrow('Computed daily interest is zero or negative');
  });
});
