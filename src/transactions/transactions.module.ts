// src/transactions/transactions.module.ts
import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { IdempotencyService } from './idempotency.service';
import { FxConversionHandler } from './handlers/fx-conversion.handler';
import { LedgerModule } from '@ledger/ledger.module';
import { AccountsModule } from '@accounts/accounts.module';
import { FxModule } from '@fx/fx.module';

@Module({
  imports: [LedgerModule, AccountsModule, FxModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, IdempotencyService, FxConversionHandler],
  exports: [TransactionsService, IdempotencyService],
})
export class TransactionsModule {}
