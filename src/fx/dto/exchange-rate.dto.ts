// src/fx/dto/exchange-rate.dto.ts
import { IsString, IsDateString, IsOptional, IsIn, IsNumberString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExchangeRateSnapshot } from '@prisma/client';
import { SUPPORTED_CURRENCIES } from '@common/types/currency.type';

export class CreateExchangeRateDto {
  @ApiProperty({
    example: 'USD',
    description: 'ISO 4217 base currency',
    enum: SUPPORTED_CURRENCIES,
  })
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, {
    message: `baseCurrency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  baseCurrency!: string;

  @ApiProperty({
    example: 'INR',
    description: 'ISO 4217 quote currency',
    enum: SUPPORTED_CURRENCIES,
  })
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, {
    message: `quoteCurrency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  quoteCurrency!: string;

  @ApiProperty({
    example: '83.42150000',
    description: '1 base = rate quote — must be a NUMERIC string',
  })
  @IsNumberString()
  rate!: string;

  @ApiProperty({
    example: 'RBI_REFERENCE',
    description: 'Rate provider: RBI_REFERENCE | OPEN_EXCHANGE_RATES | INTERNAL',
  })
  @IsString()
  source!: string;

  @ApiProperty({ example: '2026-06-26T09:00:00Z' })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({ example: '2026-06-26T10:00:00Z' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;
}

export class ExchangeRateResponseDto {
  @ApiProperty() snapshotId!: string;
  @ApiProperty() baseCurrency!: string;
  @ApiProperty() quoteCurrency!: string;
  @ApiProperty() rate!: string;
  @ApiProperty() inverseRate!: string;
  @ApiProperty() source!: string;
  @ApiProperty() capturedAt!: string;
  @ApiProperty() validFrom!: string;
  @ApiPropertyOptional() validUntil?: string | null;

  static fromPrisma(r: ExchangeRateSnapshot): ExchangeRateResponseDto {
    const dto = new ExchangeRateResponseDto();
    dto.snapshotId = r.id;
    dto.baseCurrency = r.baseCurrency;
    dto.quoteCurrency = r.quoteCurrency;
    dto.rate = r.rate.toString();
    dto.inverseRate = r.inverseRate.toString();
    dto.source = r.source;
    dto.capturedAt = r.capturedAt.toISOString();
    dto.validFrom = r.validFrom.toISOString();
    dto.validUntil = r.validUntil?.toISOString() ?? null;
    return dto;
  }
}
