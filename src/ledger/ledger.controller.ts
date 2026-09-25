// src/ledger/ledger.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { LedgerService } from './ledger.service';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { LedgerEntryResponseDto } from './dto/ledger-entry-response.dto';
import { AuditActor } from '@common/decorators/audit-actor.decorator';
import { IdempotencyKey } from '@common/decorators/idempotency.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/role.type';

@ApiTags('ledger')
@ApiSecurity('api-key')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly service: LedgerService) {}

  @Post('journal-entries')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a journal entry',
    description:
      'Creates a balanced set of debit/credit lines atomically. ' +
      'Requires X-Idempotency-Key header to prevent duplicate posting. ' +
      'ADMIN-only: this bypasses the business-rule validation the normal ' +
      '/transactions endpoint enforces for its 22 typed transaction kinds.',
  })
  @ApiCreatedResponse({ description: 'Journal entry posted successfully' })
  async postJournalEntry(
    @Body() dto: CreateJournalEntryDto,
    @AuditActor() actor: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<object> {
    const result = await this.service.postJournalEntry(dto, actor, idempotencyKey);
    return {
      journalId: result.journalId,
      entries: result.entries.map(LedgerEntryResponseDto.fromPrisma),
      totalDebits: result.totalDebits,
      totalCredits: result.totalCredits,
      postedAt: result.postedAt,
    };
  }

  @Get('journal-entries/:journalId')
  @ApiOperation({ summary: 'Get all lines of a journal entry' })
  @ApiParam({ name: 'journalId', description: 'Journal UUID' })
  @ApiOkResponse({ type: [LedgerEntryResponseDto] })
  async getJournal(
    @Param('journalId', new ParseUUIDPipe()) journalId: string,
  ): Promise<LedgerEntryResponseDto[]> {
    const entries = await this.service.getJournalEntries(journalId);
    return entries.map(LedgerEntryResponseDto.fromPrisma);
  }

  @Get('accounts/:accountId/entries')
  @ApiOperation({ summary: 'Get ledger entries for an account' })
  @ApiParam({ name: 'accountId', description: 'Account UUID' })
  @ApiQuery({ name: 'from', required: false, example: '2025-01-01' })
  @ApiQuery({ name: 'to', required: false, example: '2025-12-31' })
  @ApiOkResponse({ type: [LedgerEntryResponseDto] })
  async getAccountEntries(
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<LedgerEntryResponseDto[]> {
    const entries = await this.service.getAccountEntries(
      accountId,
      from !== undefined ? new Date(from) : undefined,
      to !== undefined ? new Date(to) : undefined,
    );
    return entries.map(LedgerEntryResponseDto.fromPrisma);
  }

  @Get('accounts/:accountId/balance')
  @ApiOperation({ summary: 'Get derived balance for an account' })
  @ApiParam({ name: 'accountId', description: 'Account UUID' })
  async getBalance(@Param('accountId', new ParseUUIDPipe()) accountId: string): Promise<object> {
    const balance = await this.service.getAccountBalance(accountId);
    return { accountId, balance, derivedAt: new Date().toISOString() };
  }
}
