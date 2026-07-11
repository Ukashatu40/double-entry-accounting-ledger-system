// tests/unit/transaction-handlers/merchant-payment-qr.handler.spec.ts
import { MerchantPaymentQrHandler } from '@transactions/handlers/merchant-payment-qr.handler';
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

describe('MerchantPaymentQrHandler', () => {
  let handler: MerchantPaymentQrHandler;
  const accounts = {
    wallet: makeAccount({ id: 'wallet-id' }),
    merchant: makeAccount({ id: 'merchant-id' }),
    feeRevenue: makeAccount({ id: 'fee-id', type: 'REVENUE' }),
    platformOperatingCash: makeAccount({ id: 'platform-id' }),
  };

  beforeEach(() => {
    handler = new MerchantPaymentQrHandler();
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

  it('rejects when the customer wallet is not active', () => {
    const accs = { ...accounts, wallet: makeAccount({ id: 'wallet-id', status: 'INACTIVE' }) };
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('Customer wallet');
  });

  it('rejects when the merchant account is not active', () => {
    const accs = { ...accounts, merchant: makeAccount({ id: 'merchant-id', status: 'CLOSED' }) };
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('Merchant settlement account');
  });

  it('rejects a zero or negative amount', () => {
    expect(() => validate({ amount: '0.0000' }, accounts)).toThrow('must be positive');
  });

  it('rejects an amount exceeding the QR payment limit', () => {
    expect(() => validate({ amount: '600000.0000' }, accounts)).toThrow('exceeds QR payment limit');
  });

  it('passes for a valid active payment within limits', async () => {
    await expect(validate({ amount: '500.0000' }, accounts)).resolves.not.toThrow();
  });

  it('applies the minimum fee floor for very small amounts', () => {
    const dto = (
      handler as unknown as {
        buildJournalEntry: (
          id: string,
          p: Record<string, unknown>,
          a: Record<string, Account>,
        ) => {
          lines: Array<{ amount: string; accountId: string }>;
        };
      }
    ).buildJournalEntry('txn-1', { amount: '10.0000', currency: 'INR' }, accounts);

    const feeLine = dto.lines.find((l) => l.accountId === 'fee-id');
    expect(feeLine?.amount).toBe('1.0000'); // 10 * 0.005 = 0.05, floored to MIN_FEE 1.0000
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
      const dto = build({ amount: '1000.0000', currency: 'INR' });
      assertJournalBalanced(dto.lines);
    });

    it('DECREASES the customer wallet balance (regression test for the fixed polarity bug)', () => {
      const dto = build({ amount: '1000.0000', currency: 'INR' });
      assertAssetAccountMoves(dto.lines, 'wallet-id', 'decrease');
    });

    it('INCREASES the merchant settlement balance', () => {
      const dto = build({ amount: '1000.0000', currency: 'INR' });
      assertAssetAccountMoves(dto.lines, 'merchant-id', 'increase');
    });
  });
});
