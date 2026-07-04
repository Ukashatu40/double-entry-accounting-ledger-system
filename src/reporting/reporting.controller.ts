// src/reporting/reporting.controller.ts
import { Controller, Get, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  // ApiOkResponse,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { TrialBalanceService } from './trial-balance.service';
import { AccountStatementService } from './account-statement.service';
import { IncomeStatementService } from './income-statement.service';
import { BalanceSheetService } from './balance-sheet.service';
import { FxExposureService } from './fx-exposure.service';

@ApiTags('reporting')
@ApiSecurity('api-key')
@Controller('reports')
export class ReportingController {
  constructor(
    private readonly trialBalanceService: TrialBalanceService,
    private readonly accountStatementService: AccountStatementService,
    private readonly incomeStatementService: IncomeStatementService,
    private readonly balanceSheetService: BalanceSheetService,
    private readonly fxExposureService: FxExposureService,
  ) {}

  @Get('trial-balance')
  @ApiOperation({ summary: 'Trial balance as of any date' })
  @ApiQuery({ name: 'asOf', required: false, example: '2026-06-27T23:59:59Z' })
  async trialBalance(@Query('asOf') asOf?: string): Promise<object> {
    return this.trialBalanceService.generate(asOf ? new Date(asOf) : undefined);
  }

  @Get('accounts/:id/statement')
  @ApiOperation({ summary: 'Account statement with running balance' })
  @ApiParam({ name: 'id', description: 'Account UUID' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false, example: '1' })
  @ApiQuery({ name: 'pageSize', required: false, example: '50' })
  async accountStatement(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<object> {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    return this.accountStatementService.generate(
      id,
      fromDate,
      toDate,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Get('income-statement')
  @ApiOperation({ summary: 'Income statement (P&L) for a period' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async incomeStatement(@Query('from') from?: string, @Query('to') to?: string): Promise<object> {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to ? new Date(to) : new Date();
    return this.incomeStatementService.generate(fromDate, toDate);
  }

  @Get('balance-sheet')
  @ApiOperation({
    summary: 'Balance sheet — verifies A = L + E',
    description: 'isBalanced must always be true. Any discrepancy is a ledger integrity issue.',
  })
  @ApiQuery({ name: 'asOf', required: false })
  async balanceSheet(@Query('asOf') asOf?: string): Promise<object> {
    return this.balanceSheetService.generate(asOf ? new Date(asOf) : new Date());
  }

  @Get('fx-exposure')
  @ApiOperation({ summary: 'Foreign currency exposure with INR equivalents' })
  @ApiQuery({ name: 'asOf', required: false })
  async fxExposure(@Query('asOf') asOf?: string): Promise<object> {
    return this.fxExposureService.generate(asOf ? new Date(asOf) : new Date());
  }
}
