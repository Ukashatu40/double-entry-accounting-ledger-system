// src/accounts/dto/create-account.dto.ts
import {
  IsString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType, AccountSubType } from '@prisma/client';
import { SUPPORTED_CURRENCIES } from '@common/types/currency.type';

export class CreateAccountDto {
  @ApiProperty({
    example: '1099',
    description:
      'Unique account code. 1xxx=Asset, 2xxx=Liability, 3xxx=Equity, 4xxx=Revenue, 5xxx=Expense',
  })
  @IsString()
  @Length(2, 20)
  @Matches(/^[0-9A-Z_-]+$/, { message: 'code must be alphanumeric' })
  code!: string;

  @ApiProperty({ example: 'Customer Wallet – GBP Holdings' })
  @IsString()
  @Length(2, 255)
  name!: string;

  @ApiProperty({ enum: AccountType })
  @IsEnum(AccountType)
  type!: AccountType;

  @ApiProperty({ enum: AccountSubType })
  @IsEnum(AccountSubType)
  subType!: AccountSubType;

  @ApiProperty({
    example: 'INR',
    description: 'ISO 4217 currency code',
    enum: SUPPORTED_CURRENCIES,
  })
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES, {
    message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
  })
  currency!: string;

  @ApiPropertyOptional({ example: 'GBP wallet for UK customers' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Parent account UUID for hierarchical CoA' })
  @IsOptional()
  @IsUUID('4')
  parentId?: string;
}
