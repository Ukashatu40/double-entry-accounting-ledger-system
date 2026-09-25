// src/accounts/accounts.repository.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Account, AccountStatus, AccountType, Prisma } from '@prisma/client';
import { DatabaseService } from '@database/database.service';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { AccountQueryDto } from './dto/account-query.dto';
import { DEFAULT_ACCOUNTS_PAGE_SIZE } from './dto/account-query.dto';

export interface PaginatedAccounts {
  data: Account[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class AccountsRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(dto: CreateAccountDto): Promise<Account> {
    return this.db.account.create({
      data: {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        subType: dto.subType,
        currency: dto.currency,
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      },
    });
  }

  async findAll(query: AccountQueryDto): Promise<PaginatedAccounts> {
    const where: Prisma.AccountWhereInput = {};

    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.currency) where.currency = query.currency;

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_ACCOUNTS_PAGE_SIZE;

    const [data, total] = await Promise.all([
      this.db.account.findMany({
        where,
        orderBy: { code: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.account.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  async findById(id: string): Promise<Account> {
    const account = await this.db.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundException(`Account ${id} not found`);
    return account;
  }

  async findByCode(code: string): Promise<Account> {
    const account = await this.db.account.findUnique({ where: { code } });
    if (!account) throw new NotFoundException(`Account with code ${code} not found`);
    return account;
  }

  async findByIds(ids: string[]): Promise<Account[]> {
    return this.db.account.findMany({
      where: { id: { in: ids } },
    });
  }

  async updateStatus(id: string, status: AccountStatus): Promise<Account> {
    // Verify it exists first
    await this.findById(id);
    return this.db.account.update({
      where: { id },
      data: { status },
    });
  }

  async existsByCode(code: string): Promise<boolean> {
    const count = await this.db.account.count({ where: { code } });
    return count > 0;
  }

  /**
   * Find all accounts of a given type — used by reporting services
   * to build trial balance, balance sheet, income statement.
   */
  async findByType(type: AccountType): Promise<Account[]> {
    return this.db.account.findMany({
      where: { type, status: 'ACTIVE' },
      orderBy: { code: 'asc' },
    });
  }
}
