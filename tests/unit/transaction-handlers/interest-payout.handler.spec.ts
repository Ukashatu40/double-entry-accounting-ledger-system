import { InterestPayoutHandler } from '@transactions/handlers/interest-payout.handler';
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

describe('InterestPayoutHandler', () => {
  let handler: InterestPayoutHandler;
  const accounts = {
    interestPayable: makeAccount({ id: 'payable-id', type: 'LIABILITY' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    tdsPayable: makeAccount({ id: 'tds-id', type: 'LIABILITY' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    handler = new InterestPayoutHandler();
  });

  it('rejects a zero or negative gross interest amount', () => {
    expect(() =>
      (
        handler as unknown as {
          validateBusinessRules: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => Promise<void>;
        }
      ).validateBusinessRules({ grossInterest: '0.0000' }, {}),
    ).toThrow('must be positive');
  });

  it('passes for a valid gross interest amount', async () => {
    await expect(
      (
        handler as unknown as {
          validateBusinessRules: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => Promise<void>;
        }
      ).validateBusinessRules({ grossInterest: '1000.0000' }, {}),
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
      const dto = build({ grossInterest: '1000.0000' });
      assertJournalBalanced(dto.lines);
    });

    it('INCREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ grossInterest: '1000.0000' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'increase');
    });
  });
});
