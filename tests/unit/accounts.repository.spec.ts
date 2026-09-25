// tests/unit/accounts.repository.spec.ts
import { NotFoundException } from '@nestjs/common';
import { AccountsRepository } from '@accounts/accounts.repository';
import type { DatabaseService } from '@database/database.service';
import type { Account } from '@prisma/client';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    code: '1099',
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

function makeMockDb(): jest.Mocked<{ account: Record<string, jest.Mock> }> {
  return {
    account: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  } as unknown as jest.Mocked<{ account: Record<string, jest.Mock> }>;
}

describe('AccountsRepository', () => {
  let repo: AccountsRepository;
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
    repo = new AccountsRepository(db as unknown as DatabaseService);
  });

  describe('create', () => {
    it('creates an account with only required fields when optional fields are absent', async () => {
      db.account.create.mockResolvedValue(makeAccount());
      await repo.create({
        code: '1099',
        name: 'Test',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
      } as never);
      const callArg = db.account.create.mock.calls[0][0];
      expect(callArg.data.description).toBeUndefined();
      expect(callArg.data.parentId).toBeUndefined();
    });

    it('includes description and parentId when provided', async () => {
      db.account.create.mockResolvedValue(makeAccount());
      await repo.create({
        code: '1099',
        name: 'Test',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
        description: 'A test account',
        parentId: 'parent-id',
      } as never);
      const callArg = db.account.create.mock.calls[0][0];
      expect(callArg.data.description).toBe('A test account');
      expect(callArg.data.parentId).toBe('parent-id');
    });
  });

  describe('findAll', () => {
    it('builds an empty where clause and defaults to page 1 / pageSize 50 when no filters are given', async () => {
      db.account.findMany.mockResolvedValue([]);
      db.account.count.mockResolvedValue(0);
      await repo.findAll({} as never);
      expect(db.account.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { code: 'asc' },
        skip: 0,
        take: 50,
      });
    });

    it('filters by type, status, and currency when all are provided', async () => {
      db.account.findMany.mockResolvedValue([]);
      db.account.count.mockResolvedValue(0);
      await repo.findAll({ type: 'ASSET', status: 'ACTIVE', currency: 'INR' } as never);
      expect(db.account.findMany).toHaveBeenCalledWith({
        where: { type: 'ASSET', status: 'ACTIVE', currency: 'INR' },
        orderBy: { code: 'asc' },
        skip: 0,
        take: 50,
      });
    });

    it('computes skip from page and pageSize', async () => {
      db.account.findMany.mockResolvedValue([]);
      db.account.count.mockResolvedValue(0);
      await repo.findAll({ page: 3, pageSize: 20 } as never);
      expect(db.account.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { code: 'asc' },
        skip: 40,
        take: 20,
      });
    });

    it('returns data, total (from count), page, and pageSize', async () => {
      const accounts = [makeAccount(), makeAccount({ id: 'acc-2', code: '1002' })];
      db.account.findMany.mockResolvedValue(accounts);
      db.account.count.mockResolvedValue(37);
      const result = await repo.findAll({ page: 2, pageSize: 20 } as never);
      expect(result).toEqual({ data: accounts, total: 37, page: 2, pageSize: 20 });
    });
  });

  describe('findById', () => {
    it('returns the account when found', async () => {
      db.account.findUnique.mockResolvedValue(makeAccount());
      const result = await repo.findById('acc-1');
      expect(result.id).toBe('acc-1');
    });

    it('throws NotFoundException when the account does not exist', async () => {
      db.account.findUnique.mockResolvedValue(null);
      await expect(repo.findById('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByCode', () => {
    it('returns the account when found', async () => {
      db.account.findUnique.mockResolvedValue(makeAccount({ code: '2001' }));
      const result = await repo.findByCode('2001');
      expect(result.code).toBe('2001');
    });

    it('throws NotFoundException with the code in the message when not found', async () => {
      db.account.findUnique.mockResolvedValue(null);
      await expect(repo.findByCode('9999')).rejects.toThrow('9999');
    });
  });

  describe('updateStatus', () => {
    it('verifies existence then updates the status', async () => {
      db.account.findUnique.mockResolvedValue(makeAccount());
      db.account.update.mockResolvedValue(makeAccount({ status: 'INACTIVE' }));
      const result = await repo.updateStatus('acc-1', 'INACTIVE');
      expect(result.status).toBe('INACTIVE');
    });

    it('throws NotFoundException if the account does not exist before updating', async () => {
      db.account.findUnique.mockResolvedValue(null);
      await expect(repo.updateStatus('missing', 'INACTIVE')).rejects.toThrow(NotFoundException);
      expect(db.account.update).not.toHaveBeenCalled();
    });
  });

  describe('existsByCode', () => {
    it('returns true when count is greater than 0', async () => {
      db.account.count.mockResolvedValue(1);
      expect(await repo.existsByCode('1001')).toBe(true);
    });

    it('returns false when count is 0', async () => {
      db.account.count.mockResolvedValue(0);
      expect(await repo.existsByCode('9999')).toBe(false);
    });
  });

  describe('findByType', () => {
    it('filters by type and ACTIVE status only', async () => {
      db.account.findMany.mockResolvedValue([]);
      await repo.findByType('ASSET');
      expect(db.account.findMany).toHaveBeenCalledWith({
        where: { type: 'ASSET', status: 'ACTIVE' },
        orderBy: { code: 'asc' },
      });
    });
  });
});
