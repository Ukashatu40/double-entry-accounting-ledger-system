// src/fx/fx.module.ts
import { Module } from '@nestjs/common';
import { FxController } from './fx.controller';
import { FxRateService } from './fx-rate.service';
import { FxRateRepository } from './fx-rate.repository';
import { FxRevaluationService } from './fx-revaluation.service';
import { LedgerModule } from '@ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [FxController],
  providers: [FxRateService, FxRateRepository, FxRevaluationService],
  exports: [FxRateService, FxRateRepository, FxRevaluationService],
})
export class FxModule {}
