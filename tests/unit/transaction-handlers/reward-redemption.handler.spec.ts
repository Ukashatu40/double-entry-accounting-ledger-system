import { RewardRedemptionHandler } from '@transactions/handlers/reward-redemption.handler';
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

describe('RewardRedemptionHandler', () => {
  let handler: RewardRedemptionHandler;
  const accounts = {
    rewardsLiability: makeAccount({ id: 'rl-id', type: 'LIABILITY' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    handler = new RewardRedemptionHandler();
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
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'INACTIVE' }) };
    expect(() => validate({ pointsRedeemed: '150' }, accs)).toThrow('not active');
  });

  it('rejects when points redeemed is below the minimum', () => {
    expect(() => validate({ pointsRedeemed: '50' }, accounts)).toThrow(
      'Minimum redemption is 100 points',
    );
  });

  it('passes for a valid redemption at or above the minimum', async () => {
    await expect(validate({ pointsRedeemed: '150' }, accounts)).resolves.not.toThrow();
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
      const dto = build({ pointsRedeemed: '400' });
      assertJournalBalanced(dto.lines);
    });

    it('INCREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ pointsRedeemed: '400' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'increase');
    });
  });
});
