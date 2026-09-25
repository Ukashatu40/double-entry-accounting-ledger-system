// src/accounts/accounts.controller.ts
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Patch,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
} from '@nestjs/swagger';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { AccountQueryDto } from './dto/account-query.dto';
import { AccountResponseDto } from './dto/account-response.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/role.type';

export interface PaginatedAccountsResponse {
  data: AccountResponseDto[];
  total: number;
  page: number;
  pageSize: number;
}

@ApiTags('accounts')
@ApiSecurity('api-key')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  @Post()
  @Roles(Role.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new account',
    description:
      'Add a new account to the Chart of Accounts. ' +
      'Account codes must be unique. Currency is immutable after creation.',
  })
  @ApiCreatedResponse({ type: AccountResponseDto })
  async create(@Body() dto: CreateAccountDto): Promise<AccountResponseDto> {
    const account = await this.service.create(dto);
    return AccountResponseDto.fromPrisma(account);
  }

  @Get()
  @ApiOperation({
    summary: 'List accounts, paginated',
    description:
      'Returns a page of the Chart of Accounts, optionally filtered by type, status, or ' +
      'currency. Defaults to page 1, pageSize 50 (max 200) if not given.',
  })
  @ApiOkResponse({ description: 'Paginated accounts: { data, total, page, pageSize }' })
  async findAll(@Query() query: AccountQueryDto): Promise<PaginatedAccountsResponse> {
    const { data, total, page, pageSize } = await this.service.findAll(query);
    return { data: data.map(AccountResponseDto.fromPrisma), total, page, pageSize };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get account by ID' })
  @ApiParam({ name: 'id', description: 'Account UUID' })
  @ApiOkResponse({ type: AccountResponseDto })
  async findById(@Param('id', new ParseUUIDPipe()) id: string): Promise<AccountResponseDto> {
    const account = await this.service.findById(id);
    return AccountResponseDto.fromPrisma(account);
  }

  @Get('code/:code')
  @ApiOperation({ summary: 'Get account by code', description: 'e.g. GET /accounts/code/1001' })
  @ApiParam({ name: 'code', example: '1001' })
  @ApiOkResponse({ type: AccountResponseDto })
  async findByCode(@Param('code') code: string): Promise<AccountResponseDto> {
    const account = await this.service.findByCode(code);
    return AccountResponseDto.fromPrisma(account);
  }

  @Patch(':id/deactivate')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Deactivate an account',
    description:
      'Marks an account as INACTIVE. The account and all its ledger entries ' +
      'remain permanently — immutability is never violated.',
  })
  @ApiOkResponse({ type: AccountResponseDto })
  async deactivate(@Param('id', new ParseUUIDPipe()) id: string): Promise<AccountResponseDto> {
    const account = await this.service.deactivate(id);
    return AccountResponseDto.fromPrisma(account);
  }
}
