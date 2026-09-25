// src/accounts/dto/account-query.dto.ts
import { IsEnum, IsOptional, IsString, Length, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType, AccountStatus } from '@prisma/client';

export const DEFAULT_ACCOUNTS_PAGE_SIZE = 50;
export const MAX_ACCOUNTS_PAGE_SIZE = 200;

export class AccountQueryDto {
  @ApiPropertyOptional({ enum: AccountType })
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @ApiPropertyOptional({ enum: AccountStatus })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  // Validated and clamped at the DTO level (the global ValidationPipe has
  // transform: true, so @Type(() => Number) coerces the raw query string
  // before @IsInt()/@Min()/@Max() run) — unlike the account-statement
  // endpoint's page/pageSize, which are plain @Query() strings with no
  // bounds checking at all.
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    example: DEFAULT_ACCOUNTS_PAGE_SIZE,
    minimum: 1,
    maximum: MAX_ACCOUNTS_PAGE_SIZE,
    default: DEFAULT_ACCOUNTS_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ACCOUNTS_PAGE_SIZE)
  pageSize?: number;
}
