// tests/unit/database.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@database/database.service';

function makeConfigService(): ConfigService {
  return {
    get: (key: string) =>
      key === 'database' ? { url: 'postgresql://fake:fake@localhost:5432/fake' } : undefined,
  } as unknown as ConfigService;
}

describe('DatabaseService', () => {
  it('throws if database configuration is missing', () => {
    const emptyConfig = { get: () => undefined } as unknown as ConfigService;
    expect(() => new DatabaseService(emptyConfig)).toThrow('Database configuration is missing');
  });

  it('isHealthy() returns false when $queryRaw throws', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$queryRaw').mockRejectedValue(new Error('connection refused'));
    const result = await db.isHealthy();
    expect(result).toBe(false);
  });

  it('isHealthy() returns true when $queryRaw succeeds', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$queryRaw').mockResolvedValue([{ '?column?': 1 }]);
    const result = await db.isHealthy();
    expect(result).toBe(true);
  });

  it('getPostgresVersion() returns "unknown" when the query returns an empty result', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$queryRaw').mockResolvedValue([]);
    const result = await db.getPostgresVersion();
    expect(result).toBe('unknown');
  });

  it('getPostgresVersion() returns the version string when present', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$queryRaw').mockResolvedValue([{ version: 'PostgreSQL 15.4' }]);
    const result = await db.getPostgresVersion();
    expect(result).toBe('PostgreSQL 15.4');
  });

  it('withTransaction() applies default maxWait, timeout, and ReadCommitted isolation', async () => {
    const db = new DatabaseService(makeConfigService());
    const txSpy = jest.spyOn(db, '$transaction').mockResolvedValue('result');
    const result = await db.withTransaction(async () => 'result');
    expect(result).toBe('result');
    expect(txSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: 5_000, timeout: 30_000, isolationLevel: 'ReadCommitted' }),
    );
  });

  it('withSerializableTransaction() uses Serializable isolation and a 15s timeout', async () => {
    const db = new DatabaseService(makeConfigService());
    const txSpy = jest.spyOn(db, '$transaction').mockResolvedValue('result');
    await db.withSerializableTransaction(async () => 'result');
    expect(txSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable', timeout: 15_000 }),
    );
  });
});
