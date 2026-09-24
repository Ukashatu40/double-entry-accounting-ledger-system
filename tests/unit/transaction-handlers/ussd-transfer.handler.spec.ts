// tests/unit/transaction-handlers/ussd-transfer.handler.spec.ts
import { UssdTransferHandler } from '@transactions/handlers/ussd-transfer.handler';
import type { Account } from '@prisma/client';
import { assertJournalBalanced, assertAssetAccountMoves } from './journal-entry-assertions.util';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    code: '1004',
    name: 'Test',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'NGN',
    status: 'ACTIVE',
    parentId: null,
    description: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Account;
}

describe('UssdTransferHandler', () => {
  let handler: UssdTransferHandler;
  const accounts = {
    senderWallet: makeAccount({ id: 'sender-id' }),
    recipientWallet: makeAccount({ id: 'recipient-id' }),
    feeRevenue: makeAccount({ id: 'fee-id', type: 'REVENUE', currency: 'INR' }),
    stampDutyPayable: makeAccount({ id: 'stamp-duty-id', type: 'LIABILITY', code: '2041' }),
    platformOperatingCash: makeAccount({ id: 'platform-id', currency: 'INR' }),
  };

  beforeEach(() => {
    handler = new UssdTransferHandler();
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

  it('rejects a non-NGN currency', () => {
    expect(() => validate({ amount: '1000.0000', currency: 'USD' }, accounts)).toThrow(
      'only supports NGN',
    );
  });

  it('rejects an amount exceeding the USSD channel limit (lower than NIP)', () => {
    expect(() => validate({ amount: '500000.0000', currency: 'NGN' }, accounts)).toThrow(
      'exceeds USSD channel limit',
    );
  });

  it('passes for a valid NGN transfer within the USSD cap', async () => {
    await expect(
      validate({ amount: '50000.0000', currency: 'NGN' }, accounts),
    ).resolves.not.toThrow();
  });

  describe('buildJournalEntry', () => {
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

    it('produces a fully balanced journal entry and moves wallets in the correct direction', () => {
      const dto = build({ amount: '5000.0000', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      assertAssetAccountMoves(dto.lines, 'sender-id', 'decrease');
      assertAssetAccountMoves(dto.lines, 'recipient-id', 'increase');
    });

    it('adds the ₦50 Stamp Duty Payable line for amounts at or above ₦10,000', () => {
      const dto = build({ amount: '15000.0000', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      const stampDutyLine = dto.lines.find((l) => l.accountId === 'stamp-duty-id');
      expect(stampDutyLine?.entryType).toBe('CREDIT');
      expect(stampDutyLine?.amount).toBe('50.0000');
    });
  });
});
