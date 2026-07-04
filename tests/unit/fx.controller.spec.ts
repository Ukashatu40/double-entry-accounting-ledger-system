// tests/unit/fx.controller.spec.ts
import { FxController } from '@fx/fx.controller';
import type { FxRateService } from '@fx/fx-rate.service';
import Decimal from 'decimal.js';
import type { ExchangeRateSnapshot } from '@prisma/client';

function makeSnapshot(overrides: Partial<ExchangeRateSnapshot> = {}): ExchangeRateSnapshot {
  return {
    id: 'snap-1',
    baseCurrency: 'USD',
    quoteCurrency: 'INR',
    rate: '83.5000' as unknown as ExchangeRateSnapshot['rate'],
    inverseRate: '0.01197605' as unknown as ExchangeRateSnapshot['inverseRate'],
    source: 'TEST',
    capturedAt: new Date(),
    validFrom: new Date(),
    validUntil: null,
    createdAt: new Date(),
    ...overrides,
  } as ExchangeRateSnapshot;
}

describe('FxController', () => {
  let controller: FxController;
  let service: jest.Mocked<FxRateService>;

  beforeEach(() => {
    service = {
      ingestRate: jest.fn(),
      getCurrentRate: jest.fn(),
      listRates: jest.fn(),
      computeConversion: jest.fn(),
    } as unknown as jest.Mocked<FxRateService>;
    controller = new FxController(service);
  });

  it('ingestRate() delegates to the service and maps the response', async () => {
    service.ingestRate.mockResolvedValue(makeSnapshot());
    const dto = {
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rate: '83.5000',
      source: 'TEST',
      validFrom: new Date().toISOString(),
    };
    const result = await controller.ingestRate(dto);
    expect(result.baseCurrency).toBe('USD');
  });

  it('getCurrent() returns the current rate for a pair', async () => {
    service.getCurrentRate.mockResolvedValue(makeSnapshot());
    const result = await controller.getCurrent('USD', 'INR');
    expect(result.snapshotId).toBe('snap-1');
  });

  it('listRates() returns mapped snapshots', async () => {
    service.listRates.mockResolvedValue([makeSnapshot(), makeSnapshot({ id: 'snap-2' })]);
    const result = await controller.listRates('USD', 'INR');
    expect(result).toHaveLength(2);
  });

  it('preview() computes and returns conversion details', async () => {
    service.computeConversion.mockResolvedValue({
      sourceAmount: new Decimal('100'),
      targetAmount: new Decimal('8350'),
      netTargetAmount: new Decimal('8308.25'),
      markupAmount: new Decimal('41.75'),
      rate: new Decimal('83.5'),
      inverseRate: new Decimal('0.011976'),
      snapshotId: 'snap-1',
    });

    const result = (await controller.preview('USD', 'INR', '100')) as {
      netAmount: string;
      rateSnapshotId: string;
    };
    expect(result.netAmount).toBe('8308.2500');
    expect(result.rateSnapshotId).toBe('snap-1');
  });
});
