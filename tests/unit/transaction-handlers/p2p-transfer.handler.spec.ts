// tests/unit/transaction-handlers/p2p-transfer.handler.spec.ts
// import { UnprocessableEntityException } from '@nestjs/common';
import { P2pTransferHandler } from '@transactions/handlers/p2p-transfer.handler';
import type { Account } from '@prisma/client';

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

describe('P2pTransferHandler', () => {
  let handler: P2pTransferHandler;
  const accounts = {
    senderWallet: makeAccount({ id: 'sender-id' }),
    recipientWallet: makeAccount({ id: 'recipient-id' }),
    feeRevenue: makeAccount({ id: 'fee-id' }),
  };

  beforeEach(() => {
    handler = new P2pTransferHandler();
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
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('Sender wallet');
  });

  it('rejects when the recipient wallet is not active', () => {
    const accs = {
      ...accounts,
      recipientWallet: makeAccount({ id: 'recipient-id', status: 'CLOSED' }),
    };
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('Recipient wallet');
  });

  it('rejects when sender and recipient are the same account', () => {
    const accs = { ...accounts, recipientWallet: makeAccount({ id: 'sender-id' }) };
    expect(() => validate({ amount: '100.0000' }, accs)).toThrow('cannot be the same account');
  });

  it('rejects when the transfer amount exceeds the maximum limit', () => {
    expect(() => validate({ amount: '300000.0000' }, accounts)).toThrow('exceeds limit');
  });

  it('passes for a valid transfer between two distinct active accounts', async () => {
    await expect(validate({ amount: '500.0000' }, accounts)).resolves.not.toThrow();
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
});
