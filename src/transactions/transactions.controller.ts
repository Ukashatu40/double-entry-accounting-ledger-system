// src/transactions/transactions.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiCreatedResponse, ApiHeader } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { AuditActor } from '@common/decorators/audit-actor.decorator';
import { IdempotencyKey } from '@common/decorators/idempotency.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/role.type';

@ApiTags('transactions')
@ApiSecurity('api-key')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Post()
  @Roles(Role.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Process a transaction',
    description:
      'Routes to the correct handler based on transaction type. ' +
      'X-Idempotency-Key is required — duplicate requests with the same key ' +
      'return the original response without reprocessing.',
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    description: 'UUID v4 — required for all transaction requests',
    required: true,
  })
  @ApiHeader({
    name: 'X-User-ID',
    description: 'The initiating user ID — used for audit trail',
    required: false,
  })
  @ApiCreatedResponse({ description: 'Transaction processed successfully' })
  async process(
    @Body() dto: CreateTransactionDto,
    @AuditActor() actor: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<object> {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'X-Idempotency-Key header is required for all transaction requests',
      );
    }

    const result = await this.service.process(dto, actor, idempotencyKey);

    return {
      transactionId: result.transactionId,
      type: result.type,
      journalId: result.journal.journalId,
      totalDebits: result.journal.totalDebits,
      totalCredits: result.journal.totalCredits,
      postedAt: result.journal.postedAt,
      entries: result.journal.entries.length,
    };
  }
}
