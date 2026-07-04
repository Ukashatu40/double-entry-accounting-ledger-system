// tests/unit/health.controller.spec.ts
import { HealthController } from '@health/health.controller';
import type { DatabaseService } from '@database/database.service';

describe('HealthController', () => {
  it('returns status ok with database version when healthy', async () => {
    const db = {
      isHealthy: jest.fn().mockResolvedValue(true),
      getPostgresVersion: jest.fn().mockResolvedValue('PostgreSQL 15.4'),
    } as unknown as DatabaseService;

    const controller = new HealthController(db);
    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.database.connected).toBe(true);
    expect(result.database.version).toBe('PostgreSQL 15.4');
    expect(typeof result.uptime).toBe('number');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it('returns status error and no version when database is unreachable', async () => {
    const db = {
      isHealthy: jest.fn().mockResolvedValue(false),
      getPostgresVersion: jest.fn(),
    } as unknown as DatabaseService;

    const controller = new HealthController(db);
    const result = await controller.check();

    expect(result.status).toBe('error');
    expect(result.database.connected).toBe(false);
    expect(result.database.version).toBeFalsy(); // accepts undefined, null, or ''
    expect(db.getPostgresVersion).not.toHaveBeenCalled();
  });
});
