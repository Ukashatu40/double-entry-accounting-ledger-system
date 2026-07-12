import { ChargebackHandler } from '@transactions/handlers/chargeback.handler';
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

describe('ChargebackHandler', () => {
  let handler: ChargebackHandler;
  const accounts = {
    merchantSettlement: makeAccount({ id: 'merchant-id' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    chargebackFeeRevenue: makeAccount({ id: 'cbfee-id', type: 'REVENUE' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    handler = new ChargebackHandler();
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

  it('rejects a zero or negative chargeback amount', () => {
    expect(() => validate({ amount: '0.0000', disputeCode: 'DC1' }, accounts)).toThrow(
      'must be positive',
    );
  });

  it('rejects when no dispute code is provided', () => {
    expect(() => validate({ amount: '500.0000' }, accounts)).toThrow('disputeCode is required');
  });

  it('passes for a valid chargeback', async () => {
    await expect(
      validate({ amount: '500.0000', disputeCode: 'DC1' }, accounts),
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
      const dto = build({ amount: '2000.0000', disputeCode: 'DC1' });
      assertJournalBalanced(dto.lines);
    });

    it('INCREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ amount: '2000.0000', disputeCode: 'DC1' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'increase');
    });

    it('DECREASES the merchant settlement balance', () => {
      const dto = build({ amount: '2000.0000', disputeCode: 'DC1' });
      assertAssetAccountMoves(dto.lines, 'merchant-id', 'decrease');
    });
  });
});
