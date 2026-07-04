// tests/unit/reporting.controller.spec.ts
import { ReportingController } from '@reporting/reporting.controller';
import type { TrialBalanceService } from '@reporting/trial-balance.service';
import type { AccountStatementService } from '@reporting/account-statement.service';
import type { IncomeStatementService } from '@reporting/income-statement.service';
import type { BalanceSheetService } from '@reporting/balance-sheet.service';
import type { FxExposureService } from '@reporting/fx-exposure.service';

describe('ReportingController', () => {
  let controller: ReportingController;
  let trialBalance: jest.Mocked<TrialBalanceService>;
  let accountStatement: jest.Mocked<AccountStatementService>;
  let incomeStatement: jest.Mocked<IncomeStatementService>;
  let balanceSheet: jest.Mocked<BalanceSheetService>;
  let fxExposure: jest.Mocked<FxExposureService>;

  beforeEach(() => {
    trialBalance = { generate: jest.fn() } as unknown as jest.Mocked<TrialBalanceService>;
    accountStatement = { generate: jest.fn() } as unknown as jest.Mocked<AccountStatementService>;
    incomeStatement = { generate: jest.fn() } as unknown as jest.Mocked<IncomeStatementService>;
    balanceSheet = { generate: jest.fn() } as unknown as jest.Mocked<BalanceSheetService>;
    fxExposure = { generate: jest.fn() } as unknown as jest.Mocked<FxExposureService>;

    controller = new ReportingController(
      trialBalance,
      accountStatement,
      incomeStatement,
      balanceSheet,
      fxExposure,
    );
  });

  it('trialBalance() passes the asOf date when provided', async () => {
    trialBalance.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.trialBalance('2026-06-30T23:59:59Z');
    expect(trialBalance.generate).toHaveBeenCalledWith(new Date('2026-06-30T23:59:59Z'));
  });

  it('trialBalance() uses undefined when no asOf date given', async () => {
    trialBalance.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.trialBalance(undefined);
    expect(trialBalance.generate).toHaveBeenCalledWith(undefined);
  });

  it('accountStatement() defaults from/to/page/pageSize when not supplied', async () => {
    accountStatement.generate.mockResolvedValue({} as never);
    await controller.accountStatement('acc-1', undefined, undefined, undefined, undefined);
    const callArgs = accountStatement.generate.mock.calls[0];
    expect(callArgs[0]).toBe('acc-1');
    expect(callArgs[3]).toBe(1);
    expect(callArgs[4]).toBe(50);
  });

  it('accountStatement() parses page and pageSize when provided as strings', async () => {
    accountStatement.generate.mockResolvedValue({} as never);
    await controller.accountStatement('acc-1', '2026-01-01', '2026-12-31', '2', '25');
    const callArgs = accountStatement.generate.mock.calls[0];
    expect(callArgs[3]).toBe(2);
    expect(callArgs[4]).toBe(25);
  });

  it('incomeStatement() defaults to the current year when no dates given', async () => {
    incomeStatement.generate.mockResolvedValue({} as never);
    await controller.incomeStatement(undefined, undefined);
    expect(incomeStatement.generate).toHaveBeenCalled();
  });

  it('balanceSheet() defaults to now when no asOf date given', async () => {
    balanceSheet.generate.mockResolvedValue({ isBalanced: true } as never);
    await controller.balanceSheet(undefined);
    expect(balanceSheet.generate).toHaveBeenCalled();
  });

  it('fxExposure() defaults to now when no asOf date given', async () => {
    fxExposure.generate.mockResolvedValue({ exposures: [] } as never);
    await controller.fxExposure(undefined);
    expect(fxExposure.generate).toHaveBeenCalled();
  });
});
