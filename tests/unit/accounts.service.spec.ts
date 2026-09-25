// tests/unit/accounts.service.spec.ts
import { ConflictException } from '@nestjs/common';
import { AccountsService } from '@accounts/accounts.service';
import type { AccountsRepository } from '@accounts/accounts.repository';
import type { Account } from '@prisma/client';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    code: '1099',
    name: 'Test Account',
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

describe('AccountsService', () => {
  let service: AccountsService;
  let repo: jest.Mocked<AccountsRepository>;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      findByCode: jest.fn(),
      findByIds: jest.fn(),
      updateStatus: jest.fn(),
      existsByCode: jest.fn(),
      findByType: jest.fn(),
    } as unknown as jest.Mocked<AccountsRepository>;
    service = new AccountsService(repo);
  });

  describe('create', () => {
    it('creates the account when the code does not already exist', async () => {
      repo.existsByCode.mockResolvedValue(false);
      repo.create.mockResolvedValue(makeAccount());

      const dto = {
        code: '1099',
        name: 'Test',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
      } as never;
      const result = await service.create(dto);

      expect(repo.create).toHaveBeenCalledWith(dto);
      expect(result.code).toBe('1099');
    });

    it('throws ConflictException when the code already exists', async () => {
      repo.existsByCode.mockResolvedValue(true);
      const dto = {
        code: '1001',
        name: 'Dup',
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'INR',
      } as never;

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('delegates to the repository with the given query and returns its paginated result as-is', async () => {
      const paginated = { data: [makeAccount()], total: 1, page: 1, pageSize: 50 };
      repo.findAll.mockResolvedValue(paginated);
      const result = await service.findAll({ type: 'ASSET' } as never);
      expect(repo.findAll).toHaveBeenCalledWith({ type: 'ASSET' });
      expect(result).toEqual(paginated);
    });
  });

  describe('findById', () => {
    it('returns the account from the repository', async () => {
      repo.findById.mockResolvedValue(makeAccount({ id: 'acc-2' }));
      const result = await service.findById('acc-2');
      expect(result.id).toBe('acc-2');
    });
  });

  describe('findByCode', () => {
    it('returns the account matching the code', async () => {
      repo.findByCode.mockResolvedValue(makeAccount({ code: '2001' }));
      const result = await service.findByCode('2001');
      expect(result.code).toBe('2001');
    });
  });

  describe('deactivate', () => {
    it('updates the account status to INACTIVE', async () => {
      repo.updateStatus.mockResolvedValue(makeAccount({ status: 'INACTIVE' }));
      const result = await service.deactivate('acc-1');
      expect(repo.updateStatus).toHaveBeenCalledWith('acc-1', 'INACTIVE');
      expect(result.status).toBe('INACTIVE');
    });
  });
});
