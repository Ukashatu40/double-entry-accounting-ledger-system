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
    vatPayable: makeAccount({ id: 'vat-id', type: 'LIABILITY', code: '2040' }),
    cybersecurityLevyPayable: makeAccount({ id: 'levy-id', type: 'LIABILITY', code: '2042' }),
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

      // sender debit = amount(5000) + fee(10) + vat(0.75) + levy(0.25) = 5011.0000
      const senderLine = dto.lines.find((l) => l.accountId === 'sender-id');
      expect(senderLine?.amount).toBe('5011.0000');
    });

    it('adds the ₦50 Stamp Duty Payable line for amounts at or above ₦10,000, alongside VAT and the cybersecurity levy', () => {
      const dto = build({ amount: '15000.0000', currency: 'NGN' });
      assertJournalBalanced(dto.lines);
      const stampDutyLine = dto.lines.find((l) => l.accountId === 'stamp-duty-id');
      expect(stampDutyLine?.entryType).toBe('CREDIT');
      expect(stampDutyLine?.amount).toBe('50.0000');

      const vatLine = dto.lines.find((l) => l.accountId === 'vat-id');
      expect(vatLine?.amount).toBe('0.7500'); // 7.5% of fee 10.0000

      const levyLine = dto.lines.find((l) => l.accountId === 'levy-id');
      expect(levyLine?.amount).toBe('0.7500'); // 0.005% of amount 15000

      // sender debit = 15000 + 10 + 50 + 0.75 + 0.75 = 15061.5000
      const senderLine = dto.lines.find((l) => l.accountId === 'sender-id');
      expect(senderLine?.amount).toBe('15061.5000');
    });
  });

  describe('getLimitCheckSpecs', () => {
    it('checks the sender wallet against the same total used in buildJournalEntry', () => {
      const result = (
        handler as unknown as {
          getLimitCheckSpecs: (
            p: Record<string, unknown>,
            a: Record<string, Account>,
          ) => { accountId: string; amount: string }[];
        }
      ).getLimitCheckSpecs({ amount: '15000.0000', currency: 'NGN' }, accounts);
      expect(result).toEqual([{ accountId: 'sender-id', amount: '15061.5000' }]);
    });
  });
});
