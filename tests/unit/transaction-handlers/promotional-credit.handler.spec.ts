import { PromotionalCreditHandler } from '@transactions/handlers/promotional-credit.handler';
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

describe('PromotionalCreditHandler', () => {
  let handler: PromotionalCreditHandler;
  const accounts = {
    cashbackExpense: makeAccount({ id: 'cb-id', type: 'EXPENSE' }),
    wallet: makeAccount({ id: 'wallet-id' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    handler = new PromotionalCreditHandler();
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
    expect(() => validate({ amount: '50.0000', promoCode: 'PROMO1' }, accs)).toThrow('not active');
  });

  it('rejects when no promo code is provided', () => {
    expect(() => validate({ amount: '50.0000' }, accounts)).toThrow('promoCode is required');
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000', promoCode: 'PROMO1' }, accounts)).toThrow(
      'must be positive',
    );
  });

  it('passes for a valid promotional credit', async () => {
    await expect(
      validate({ amount: '50.0000', promoCode: 'PROMO1' }, accounts),
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
      const dto = build({ amount: '50.0000', currency: 'INR', promoCode: 'PROMO1' });
      assertJournalBalanced(dto.lines);
    });

    it('INCREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ amount: '50.0000', currency: 'INR', promoCode: 'PROMO1' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'increase');
    });
  });
});
