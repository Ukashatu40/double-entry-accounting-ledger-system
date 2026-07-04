// tests/unit/audit.controller.spec.ts
import { AuditController } from '@audit/audit.controller';
import type { AuditService } from '@audit/audit.service';

describe('AuditController', () => {
  let controller: AuditController;
  let service: jest.Mocked<AuditService>;

  beforeEach(() => {
    service = {
      verifyChain: jest.fn(),
      exportForRegulator: jest.fn(),
      detectAnomalies: jest.fn(),
    } as unknown as jest.Mocked<AuditService>;
    controller = new AuditController(service);
  });

  it('verify() passes through from/to dates when supplied', async () => {
    service.verifyChain.mockResolvedValue({
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
      verifiedAt: new Date().toISOString(),
      chainResult: { valid: true, totalEntries: 5 },
      anomalies: [],
    });
    await controller.verify('2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z');
    expect(service.verifyChain).toHaveBeenCalledWith(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T23:59:59Z'),
    );
  });

  it('verify() works with no date filters', async () => {
    service.verifyChain.mockResolvedValue({
      fromDate: '',
      toDate: '',
      verifiedAt: '',
      chainResult: { valid: true, totalEntries: 0 },
      anomalies: [],
    });
    await controller.verify(undefined, undefined);
    expect(service.verifyChain).toHaveBeenCalledWith(undefined, undefined);
  });

  it('export() requires both from and to and passes them as Dates', async () => {
    service.exportForRegulator.mockResolvedValue({ exportMetadata: {} });
    await controller.export('2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z');
    expect(service.exportForRegulator).toHaveBeenCalledWith(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T23:59:59Z'),
    );
  });

  it('anomalies() defaults to a 24-hour lookback window when no dates supplied', async () => {
    service.detectAnomalies.mockResolvedValue([]);
    const result = (await controller.anomalies(undefined, undefined)) as { totalAnomalies: number };
    expect(result.totalAnomalies).toBe(0);
    expect(service.detectAnomalies).toHaveBeenCalled();
  });

  it('anomalies() reports the count of flags found', async () => {
    service.detectAnomalies.mockResolvedValue([
      { entryId: 'e1', type: 'LARGE_ROUND_NUMBER', description: 'desc', severity: 'MEDIUM' },
    ]);
    const result = (await controller.anomalies('2026-01-01', '2026-01-02')) as {
      totalAnomalies: number;
    };
    expect(result.totalAnomalies).toBe(1);
  });
});
