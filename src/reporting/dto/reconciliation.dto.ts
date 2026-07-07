// src/reporting/dto/reconciliation.dto.ts
import {
  IsArray,
  IsString,
  IsNumberString,
  IsDateString,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A single line from an external source — a bank statement export or
 * payment gateway settlement file. In production this would be parsed
 * from a CSV/API response from the bank/NPCI/gateway; here it is
 * supplied directly by the caller (or generated via the demo fixture
 * endpoint) to keep the reconciliation engine testable without a live
 * external integration.
 */
export class ExternalStatementLineDto {
  @ApiProperty({
    description:
      "The external system's reference for this transaction. Expected to " +
      'correspond to our internal transaction/reference ID (referenceId on ' +
      'the ledger entry) — in a real integration this mapping is usually ' +
      'established via a shared idempotency key, UTR, or ARN.',
    example: '019f272c-667a-7ee5-a6ca-a777a655b97e',
  })
  @IsString()
  externalReference!: string;

  @ApiProperty({ example: '5000.0000' })
  @IsNumberString()
  amount!: string;

  @ApiProperty({ example: 'INR' })
  @IsString()
  currency!: string;

  @ApiProperty({ example: '2026-06-27T00:00:00Z' })
  @IsDateString()
  date!: string;
}

export class ReconciliationRequestDto {
  @ApiProperty({ example: '2026-06-01T00:00:00Z' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-06-30T23:59:59Z' })
  @IsDateString()
  to!: string;

  @ApiProperty({ type: [ExternalStatementLineDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExternalStatementLineDto)
  externalStatement!: ExternalStatementLineDto[];
}
