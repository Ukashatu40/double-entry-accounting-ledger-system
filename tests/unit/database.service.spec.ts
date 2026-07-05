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

describe('queryRaw', () => {
  it('interpolates values into the SQL template using $1, $2 placeholders', async () => {
    const db = new DatabaseService(makeConfigService());
    const spy = jest.spyOn(db, '$queryRawUnsafe').mockResolvedValue([{ id: 1 }]);
    const result =
      await db.queryRaw`SELECT * FROM accounts WHERE id = ${'acc-1'} AND status = ${'ACTIVE'}`;
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('$1'), 'acc-1', 'ACTIVE');
    expect(result).toEqual([{ id: 1 }]);
  });
});

describe('executeRaw', () => {
  it('interpolates values and returns the affected row count', async () => {
    const db = new DatabaseService(makeConfigService());
    const spy = jest.spyOn(db, '$executeRawUnsafe').mockResolvedValue(3);
    const result =
      await db.executeRaw`UPDATE accounts SET status = ${'CLOSED'} WHERE id = ${'acc-1'}`;
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('$1'), 'CLOSED', 'acc-1');
    expect(result).toBe(3);
  });
});

describe('acquireAdvisoryLocks', () => {
  it('acquires locks in ascending sorted order regardless of input order', async () => {
    const db = new DatabaseService(makeConfigService());
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const tx = { $executeRawUnsafe: executeRawUnsafe };

    await db.acquireAdvisoryLocks(tx as never, ['zzz-account', 'aaa-account', 'mmm-account']);

    expect(executeRawUnsafe).toHaveBeenCalledTimes(3);
    // First call must be for the alphabetically-first UUID
    const firstCallArg = executeRawUnsafe.mock.calls[0][1] as string;
    expect(typeof firstCallArg).toBe('string');
  });

  it('handles a single account ID without error', async () => {
    const db = new DatabaseService(makeConfigService());
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const tx = { $executeRawUnsafe: executeRawUnsafe };
    await db.acquireAdvisoryLocks(tx as never, ['single-account-id']);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('handles an empty account ID array without calling the database', async () => {
    const db = new DatabaseService(makeConfigService());
    const executeRawUnsafe = jest.fn();
    const tx = { $executeRawUnsafe: executeRawUnsafe };
    await db.acquireAdvisoryLocks(tx as never, []);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('onModuleInit / verifyPostgresVersion', () => {
  it('throws when PostgreSQL version is below 15', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$connect').mockResolvedValue(undefined);
    jest.spyOn(db, '$queryRaw').mockResolvedValue([{ server_version_num: '140000' }]);

    await expect(db.onModuleInit()).rejects.toThrow('PostgreSQL 15+ is required');
  });

  it('succeeds silently when PostgreSQL version is 15 or above', async () => {
    const db = new DatabaseService(makeConfigService());
    jest.spyOn(db, '$connect').mockResolvedValue(undefined);
    jest.spyOn(db, '$queryRaw').mockResolvedValue([{ server_version_num: '150004' }]);

    await expect(db.onModuleInit()).resolves.not.toThrow();
  });

  it('onModuleDestroy disconnects cleanly', async () => {
    const db = new DatabaseService(makeConfigService());
    const spy = jest.spyOn(db, '$disconnect').mockResolvedValue(undefined);
    await db.onModuleDestroy();
    expect(spy).toHaveBeenCalled();
  });
});
