// src/reporting/reporting.module.ts
import { Module } from '@nestjs/common';
import { TrialBalanceService } from './trial-balance.service';
import { AccountStatementService } from './account-statement.service';
import { IncomeStatementService } from './income-statement.service';
import { BalanceSheetService } from './balance-sheet.service';
import { FxExposureService } from './fx-exposure.service';
import { ReconciliationService } from './reconciliation.service';
import { ReportingController } from './reporting.controller';

@Module({
  controllers: [ReportingController],
  providers: [
    TrialBalanceService,
    AccountStatementService,
    IncomeStatementService,
    BalanceSheetService,
    FxExposureService,
    ReconciliationService,
  ],
  exports: [
    TrialBalanceService,
    AccountStatementService,
    IncomeStatementService,
    BalanceSheetService,
    FxExposureService,
    ReconciliationService,
  ],
})
export class ReportingModule {}
