// tests/unit/reporting.controller.spec.ts
import { ReportingController } from '@reporting/reporting.controller';
import type { TrialBalanceService } from '@reporting/trial-balance.service';
import type { AccountStatementService } from '@reporting/account-statement.service';
import type { IncomeStatementService } from '@reporting/income-statement.service';
import type { BalanceSheetService } from '@reporting/balance-sheet.service';
import type { FxExposureService } from '@reporting/fx-exposure.service';
import { ReconciliationService } from '@reporting/reconciliation.service';

describe('ReportingController', () => {
  let controller: ReportingController;
  let trialBalanceSvc: jest.Mocked<TrialBalanceService>;
  let accountStatementSvc: jest.Mocked<AccountStatementService>;
  let incomeStatementSvc: jest.Mocked<IncomeStatementService>;
  let balanceSheetSvc: jest.Mocked<BalanceSheetService>;
  let fxExposureSvc: jest.Mocked<FxExposureService>;
  let reconciliationSvc: jest.Mocked<ReconciliationService>;

  beforeEach(() => {
    trialBalanceSvc = { generate: jest.fn() } as unknown as jest.Mocked<TrialBalanceService>;
    accountStatementSvc = {
      generate: jest.fn(),
    } as unknown as jest.Mocked<AccountStatementService>;
    incomeStatementSvc = { generate: jest.fn() } as unknown as jest.Mocked<IncomeStatementService>;
    balanceSheetSvc = { generate: jest.fn() } as unknown as jest.Mocked<BalanceSheetService>;
    fxExposureSvc = { generate: jest.fn() } as unknown as jest.Mocked<FxExposureService>;
    reconciliationSvc = { generate: jest.fn() } as unknown as jest.Mocked<ReconciliationService>;

    controller = new ReportingController(
      trialBalanceSvc,
      accountStatementSvc,
      incomeStatementSvc,
      balanceSheetSvc,
      fxExposureSvc,
      reconciliationSvc,
    );
  });

  it('trialBalance() passes the asOf date when provided', async () => {
    trialBalanceSvc.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.trialBalance('2026-06-30T23:59:59Z');
    expect(trialBalanceSvc.generate).toHaveBeenCalledWith(new Date('2026-06-30T23:59:59Z'));
  });

  it('trialBalance() uses undefined when no asOf date given', async () => {
    trialBalanceSvc.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.trialBalance(undefined);
    expect(trialBalanceSvc.generate).toHaveBeenCalledWith(undefined);
  });

  it('accountStatement() defaults from/to/page/pageSize when not supplied', async () => {
    accountStatementSvc.generate.mockResolvedValue({} as never);
    await controller.accountStatement('acc-1', undefined, undefined, undefined, undefined);
    const callArgs = accountStatementSvc.generate.mock.calls[0];
    expect(callArgs[0]).toBe('acc-1');
    expect(callArgs[3]).toBe(1);
    expect(callArgs[4]).toBe(50);
  });

  it('accountStatement() parses page and pageSize when provided as strings', async () => {
    accountStatementSvc.generate.mockResolvedValue({} as never);
    await controller.accountStatement('acc-1', '2026-01-01', '2026-12-31', '2', '25');
    const callArgs = accountStatementSvc.generate.mock.calls[0];
    expect(callArgs[3]).toBe(2);
    expect(callArgs[4]).toBe(25);
  });

  it('incomeStatement() defaults to the current year when no dates given', async () => {
    incomeStatementSvc.generate.mockResolvedValue({} as never);
    await controller.incomeStatement(undefined, undefined);
    expect(incomeStatementSvc.generate).toHaveBeenCalled();
  });

  it('balanceSheet() defaults to now when no asOf date given', async () => {
    balanceSheetSvc.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.balanceSheet(undefined);
    expect(balanceSheetSvc.generate).toHaveBeenCalled();
  });

  it('fxExposure() defaults to now when no asOf date given', async () => {
    fxExposureSvc.generate.mockResolvedValue({ exposures: [] } as never);
    await controller.fxExposure(undefined);
    expect(fxExposureSvc.generate).toHaveBeenCalled();
  });
});
