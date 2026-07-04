// tests/unit/fx-rate.service.spec.ts
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { FxRateService } from '@fx/fx-rate.service';
import type { FxRateRepository } from '@fx/fx-rate.repository';
import type { ExchangeRateSnapshot } from '@prisma/client';

function makeSnapshot(overrides: Partial<ExchangeRateSnapshot> = {}): ExchangeRateSnapshot {
  return {
    id: 'snap-1',
    baseCurrency: 'USD',
    quoteCurrency: 'INR',
    rate: new Decimal('83.5000') as unknown as ExchangeRateSnapshot['rate'],
    inverseRate: new Decimal('0.01197605') as unknown as ExchangeRateSnapshot['inverseRate'],
    source: 'TEST',
    capturedAt: new Date(),
    validFrom: new Date(),
    validUntil: null,
    createdAt: new Date(),
    ...overrides,
  } as ExchangeRateSnapshot;
}

function makeConfigService(maxAgeMinutes: number): ConfigService {
  return {
    get: (key: string) => (key === 'app' ? { fxRateMaxAgeMinutes: maxAgeMinutes } : undefined),
  } as unknown as ConfigService;
}

describe('FxRateService', () => {
  let service: FxRateService;
  let repo: jest.Mocked<FxRateRepository>;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findCurrent: jest.fn(),
      findAtTime: jest.fn(),
      findAll: jest.fn(),
    } as unknown as jest.Mocked<FxRateRepository>;
    service = new FxRateService(repo, makeConfigService(60));
  });

  describe('getCurrentRate', () => {
    it('returns the rate when it is fresh', async () => {
      repo.findCurrent.mockResolvedValue(makeSnapshot({ capturedAt: new Date() }));
      const result = await service.getCurrentRate('USD', 'INR');
      expect(result.baseCurrency).toBe('USD');
    });

    it('throws NotFoundException when no rate exists for the pair', async () => {
      repo.findCurrent.mockResolvedValue(null);
      await expect(service.getCurrentRate('XYZ', 'INR')).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when the rate is stale', async () => {
      const staleDate = new Date(Date.now() - 90 * 60 * 1000);
      repo.findCurrent.mockResolvedValue(makeSnapshot({ capturedAt: staleDate }));
      await expect(service.getCurrentRate('USD', 'INR')).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.getCurrentRate('USD', 'INR')).rejects.toThrow('is stale');
    });
  });

  describe('computeConversion', () => {
    it('computes gross, markup, and net amounts correctly', async () => {
      repo.findCurrent.mockResolvedValue(makeSnapshot({ capturedAt: new Date() }));
      const result = await service.computeConversion('USD', 'INR', new Decimal('100'));

      expect(result.targetAmount.toFixed(4)).toBe('8350.0000');
      expect(result.markupAmount.toFixed(4)).toBe('41.7500');
      expect(result.netTargetAmount.toFixed(4)).toBe('8308.2500');
    });
  });

  describe('getRateAtTime', () => {
    it('returns the historical rate for a given timestamp', async () => {
      repo.findAtTime.mockResolvedValue(makeSnapshot());
      const result = await service.getRateAtTime('USD', 'INR', new Date('2026-01-01'));
      expect(result.id).toBe('snap-1');
    });

    it('throws NotFoundException when no historical rate is found', async () => {
      repo.findAtTime.mockResolvedValue(null);
      await expect(service.getRateAtTime('USD', 'INR', new Date('2020-01-01'))).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listRates', () => {
    it('delegates to the repository with optional filters', async () => {
      repo.findAll.mockResolvedValue([makeSnapshot()]);
      const result = await service.listRates('USD', 'INR');
      expect(repo.findAll).toHaveBeenCalledWith('USD', 'INR');
      expect(result).toHaveLength(1);
    });

    it('works with no filters at all', async () => {
      repo.findAll.mockResolvedValue([]);
      await service.listRates();
      expect(repo.findAll).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('ingestRate', () => {
    it('delegates to the repository create method', async () => {
      repo.create.mockResolvedValue(makeSnapshot());
      const dto = {
        baseCurrency: 'USD',
        quoteCurrency: 'INR',
        rate: '83.5000',
        source: 'TEST',
        validFrom: new Date().toISOString(),
      };
      await service.ingestRate(dto as never);
      expect(repo.create).toHaveBeenCalledWith(dto);
    });
  });
});
