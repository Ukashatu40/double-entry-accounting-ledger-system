// tests/unit/accounts.controller.spec.ts
import { AccountsController } from '@accounts/accounts.controller';
import type { AccountsService } from '@accounts/accounts.service';
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

describe('AccountsController', () => {
  let controller: AccountsController;
  let service: jest.Mocked<AccountsService>;

  beforeEach(() => {
    service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      findByCode: jest.fn(),
      deactivate: jest.fn(),
    } as unknown as jest.Mocked<AccountsService>;
    controller = new AccountsController(service);
  });

  it('create() delegates to the service and returns a mapped DTO', async () => {
    service.create.mockResolvedValue(makeAccount());
    const result = await controller.create({
      code: '1099',
      name: 'Test',
      type: 'ASSET',
      subType: 'CURRENT_ASSET',
      currency: 'INR',
    } as never);
    expect(result.code).toBe('1099');
  });

  it('findAll() delegates to the service with the query and maps results', async () => {
    service.findAll.mockResolvedValue([makeAccount(), makeAccount({ id: 'acc-2', code: '1002' })]);
    const result = await controller.findAll({} as never);
    expect(result).toHaveLength(2);
  });

  it('findById() returns a single mapped account', async () => {
    service.findById.mockResolvedValue(makeAccount({ id: 'acc-5' }));
    const result = await controller.findById('acc-5');
    expect(result.id).toBe('acc-5');
  });

  it('findByCode() returns a single mapped account', async () => {
    service.findByCode.mockResolvedValue(makeAccount({ code: '2001' }));
    const result = await controller.findByCode('2001');
    expect(result.code).toBe('2001');
  });

  it('deactivate() delegates to the service and returns the updated account', async () => {
    service.deactivate.mockResolvedValue(makeAccount({ status: 'INACTIVE' }));
    const result = await controller.deactivate('acc-1');
    expect(result.status).toBe('INACTIVE');
    expect(service.deactivate).toHaveBeenCalledWith('acc-1');
  });
});
