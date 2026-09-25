// src/reversals/reversals.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiCreatedResponse, ApiHeader } from '@nestjs/swagger';
import { ReversalsService } from './reversals.service';
import { FullReversalDto, PartialRefundDto } from './dto/reversal.dto';
import { AuditActor } from '@common/decorators/audit-actor.decorator';
import { IdempotencyKey } from '@common/decorators/idempotency.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/role.type';

@ApiTags('reversals')
@ApiSecurity('api-key')
@Controller('reversals')
export class ReversalsController {
  constructor(private readonly service: ReversalsService) {}

  @Post('full')
  @Roles(Role.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Full reversal of a transaction',
    description:
      'Creates an exact mirror of the original journal entry. ' +
      'The original entries are never modified (no-mutation principle). ' +
      'Idempotent — duplicate requests with same key return original response.',
  })
  @ApiHeader({ name: 'X-Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'Reversal posted' })
  async fullReversal(
    @Body() dto: FullReversalDto,
    @AuditActor() actor: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<object> {
    if (!idempotencyKey) {
      throw new BadRequestException('X-Idempotency-Key is required');
    }
    return this.service.reverseTransaction(dto, actor, idempotencyKey);
  }

  @Post('partial')
  @Roles(Role.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Partial refund with configurable fee policy',
    description:
      'Supports PROPORTIONAL, FULL, and NONE fee policies (spec A5.2). ' +
      'Cumulative refunds across multiple partial refunds are validated ' +
      'against the original amount — cannot exceed original total.',
  })
  @ApiHeader({ name: 'X-Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'Partial refund posted' })
  async partialRefund(
    @Body() dto: PartialRefundDto,
    @AuditActor() actor: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<object> {
    if (!idempotencyKey) {
      throw new BadRequestException('X-Idempotency-Key is required');
    }
    return this.service.partialRefund(dto, actor, idempotencyKey);
  }
}
