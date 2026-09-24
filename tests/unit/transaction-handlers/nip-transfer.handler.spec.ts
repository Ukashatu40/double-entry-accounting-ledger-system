// tests/unit/transaction-handlers/nip-transfer.handler.spec.ts
import { NipTransferHandler } from '@transactions/handlers/nip-transfer.handler';
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

describe('NipTransferHandler', () => {
  let handler: NipTransferHandler;
  const accounts = {
    senderWallet: makeAccount({ id: 'sender-id' }),
    recipientWallet: makeAccount({ id: 'recipient-id' }),
    feeRevenue: makeAccount({ id: 'fee-id', type: 'REVENUE', currency: 'INR' }),
    stampDutyPayable: makeAccount({ id: 'stamp-duty-id', type: 'LIABILITY', code: '2041' }),
    platformOperatingCash: makeAccount({ id: 'platform-id', currency: 'INR' }),
  };

  beforeEach(() => {
    handler = new NipTransferHandler();
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

  it('rejects when the sender wallet is not active', () => {
    const accs = {
      ...accounts,
      senderWallet: makeAccount({ id: 'sender-id', status: 'INACTIVE' }),
    };
    expect(() => validate({ amount: '1000.0000', currency: 'NGN' }, accs)).toThrow('Sender wallet');
  });

  it('rejects when the recipient wallet is not active', () => {
    const accs = {
      ...accounts,
      recipientWallet: makeAccount({ id: 'recipient-id', status: 'CLOSED' }),
    };
    expect(() => validate({ amount: '1000.0000', currency: 'NGN' }, accs)).toThrow(
      'Recipient wallet',
    );
  });

  it('rejects when sender and recipient are the same account', () => {
    const accs = { ...accounts, recipientWallet: makeAccount({ id: 'sender-id' }) };
    expect(() => validate({ amount: '1000.0000', currency: 'NGN' }, accs)).toThrow(
      'cannot be the same account',
    );
  });

  it('rejects a non-NGN currency', () => {
    expect(() => validate({ amount: '1000.0000', currency: 'INR' }, accounts)).toThrow(
      'only supports NGN',
    );
  });

  it('rejects an unsupported currency code outright', () => {
    expect(() => validate({ amount: '1000.0000', currency: 'ZZZ' }, accounts)).toThrow(
      'Unsupported currency',
    );
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000', currency: 'NGN' }, accounts)).toThrow(
      'must be positive',
    );
  });

  it('rejects an amount exceeding the transfer limit', () => {
    expect(() => validate({ amount: '9000000.0000', currency: 'NGN' }, accounts)).toThrow(
      'exceeds limit',
    );
  });

  it('passes for a valid NGN transfer between distinct active accounts', async () => {
    await expect(
      validate({ amount: '5000.0000', currency: 'NGN' }, accounts),
    ).resolves.not.toThrow();
  });

  describe('getBalanceCheckAccounts', () => {
    it('returns the sender wallet id', () => {
      const result = (
        handler as unknown as {
          getBalanceCheckAccounts: (p: unknown, a: Record<string, Account>) => string[];
        }
      ).getBalanceCheckAccounts({}, accounts);
      expect(result).toEqual(['sender-id']);
    });
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

    it('produces a fully balanced journal entry when the amount is below the stamp duty threshold', () => {
      const dto = build({ amount: '5000.0000', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      const stampDutyLine = dto.lines.find((l) => l.accountId === 'stamp-duty-id');
      expect(stampDutyLine).toBeUndefined();
    });

    it('DECREASES the sender wallet and INCREASES the recipient wallet', () => {
      const dto = build({ amount: '5000.0000', currency: 'NGN' });
      assertAssetAccountMoves(dto.lines, 'sender-id', 'decrease');
      assertAssetAccountMoves(dto.lines, 'recipient-id', 'increase');
    });

    it('adds a Stamp Duty Payable line of exactly ₦50 for amounts at or above ₦10,000 (regression test for the threshold)', () => {
      const dto = build({ amount: '10000.0000', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      const stampDutyLine = dto.lines.find((l) => l.accountId === 'stamp-duty-id');
      expect(stampDutyLine?.entryType).toBe('CREDIT');
      expect(stampDutyLine?.amount).toBe('50.0000');

      // sender debit = amount(10000) + fee(26.88) + stampDuty(50) = 10076.8800
      const senderLine = dto.lines.find((l) => l.accountId === 'sender-id');
      expect(senderLine?.amount).toBe('10076.8800');
    });

    it('omits the Stamp Duty Payable line just below the ₦10,000 threshold', () => {
      const dto = build({ amount: '9999.9999', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      const stampDutyLine = dto.lines.find((l) => l.accountId === 'stamp-duty-id');
      expect(stampDutyLine).toBeUndefined();
    });

    it('plugs the residual on platformOperatingCash (see ADR-007)', () => {
      const dto = build({ amount: '10000.0000', currency: 'NGN' });
      const plugLine = dto.lines.find((l) => l.accountId === 'platform-id');
      expect(plugLine).toBeDefined();
      assertJournalBalanced(dto.lines);
    });
  });
});
