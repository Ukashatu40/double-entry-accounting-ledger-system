// src/audit/audit.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/role.type';

@ApiTags('audit')
@ApiSecurity('api-key')
@Controller('audit')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get('verify')
  @ApiOperation({
    summary: 'Verify hash chain integrity',
    description:
      'Traverses all POSTED ledger entries in insertion order and recomputes ' +
      'each SHA-256 hash. Any tampered entry breaks the chain and is reported. ' +
      'Also runs anomaly detection (large round numbers, after-hours posting).',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-01-01T00:00:00Z' })
  @ApiQuery({ name: 'to', required: false, example: '2026-12-31T23:59:59Z' })
  @ApiOkResponse({ description: 'Audit verification report' })
  async verify(@Query('from') from?: string, @Query('to') to?: string): Promise<object> {
    return this.service.verifyChain(
      from !== undefined ? new Date(from) : undefined,
      to !== undefined ? new Date(to) : undefined,
    );
  }

  @Get('export')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Export tamper-evident ledger package',
    description:
      'Returns a complete ledger export with chain verification results. ' +
      'Format suitable for regulatory submission (RBI, FEMA, Big 4 auditors). ' +
      'Referenced in spec Case Studies 3 (Wirecard) and 5 (SVB).',
  })
  @ApiQuery({ name: 'from', required: true, example: '2026-01-01T00:00:00Z' })
  @ApiQuery({ name: 'to', required: true, example: '2026-12-31T23:59:59Z' })
  async export(@Query('from') from: string, @Query('to') to: string): Promise<object> {
    return this.service.exportForRegulator(new Date(from), new Date(to));
  }

  @Get('anomalies')
  @ApiOperation({
    summary: 'Run anomaly detection only',
    description:
      'Flags suspicious patterns without running full hash verification. ' +
      'Faster for operational monitoring.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async anomalies(@Query('from') from?: string, @Query('to') to?: string): Promise<object> {
    const fromDate =
      from !== undefined ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to !== undefined ? new Date(to) : new Date();
    const flags = await this.service.detectAnomalies(fromDate, toDate);
    return {
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      checkedAt: new Date().toISOString(),
      totalAnomalies: flags.length,
      anomalies: flags,
    };
  }
}
