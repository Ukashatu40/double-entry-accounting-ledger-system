// src/accounts/accounts.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import type { Account } from '@prisma/client';
import { AccountsRepository, type PaginatedAccounts } from './accounts.repository';
import type { CreateAccountDto } from './dto/create-account.dto';
import type { AccountQueryDto } from './dto/account-query.dto';

@Injectable()
export class AccountsService {
  constructor(private readonly repo: AccountsRepository) {}

  async create(dto: CreateAccountDto): Promise<Account> {
    const exists = await this.repo.existsByCode(dto.code);
    if (exists) {
      throw new ConflictException(`Account with code ${dto.code} already exists`);
    }
    return this.repo.create(dto);
  }

  async findAll(query: AccountQueryDto): Promise<PaginatedAccounts> {
    return this.repo.findAll(query);
  }

  async findById(id: string): Promise<Account> {
    return this.repo.findById(id);
  }

  async findByCode(code: string): Promise<Account> {
    return this.repo.findByCode(code);
  }

  async deactivate(id: string): Promise<Account> {
    return this.repo.updateStatus(id, 'INACTIVE');
  }
}
