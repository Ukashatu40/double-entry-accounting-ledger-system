// tests/unit/idempotency.service.spec.ts
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdempotencyService } from '@transactions/idempotency.service';
import type { DatabaseService } from '@database/database.service';

function makeConfigService(): ConfigService {
  return {
    get: (key: string) => (key === 'app' ? { idempotencyTtlHours: 24 } : undefined),
  } as unknown as ConfigService;
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let db: {
    withSerializableTransaction: jest.Mock;
    idempotencyKey: { update: jest.Mock; updateMany: jest.Mock };
  };

  beforeEach(() => {
    db = {
      withSerializableTransaction: jest.fn(),
      idempotencyKey: { update: jest.fn(), updateMany: jest.fn() },
    };
    service = new IdempotencyService(db as unknown as DatabaseService, makeConfigService());
  });

  describe('checkAndReserve', () => {
    it('creates a new key when none exists and returns isNew=true', async () => {
      db.withSerializableTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({
          idempotencyKey: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'key-1', status: 'PROCESSING' }),
          },
        }),
      );

      const result = await service.checkAndReserve('key-abc', 'user-1', '/transactions', { a: 1 });
      expect(result.isNew).toBe(true);
    });

    it('replays when the same key and same body hash already exist', async () => {
      const existing = {
        id: 'key-1',
        requestHash: expect.any(String) as unknown as string,
        status: 'COMPLETED',
      };
      db.withSerializableTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
        const crypto = await import('crypto');
        const hash = crypto
          .createHash('sha256')
          .update(JSON.stringify({ a: 1 }), 'utf8')
          .digest('hex');
        return cb({
          idempotencyKey: {
            findUnique: jest.fn().mockResolvedValue({ ...existing, requestHash: hash }),
          },
        });
      });

      const result = await service.checkAndReserve('key-abc', 'user-1', '/transactions', { a: 1 });
      expect(result.isNew).toBe(false);
    });

    it('throws ConflictException when the same key is reused with a different body', async () => {
      db.withSerializableTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({
          idempotencyKey: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'key-1',
              requestHash: 'different-hash-value',
              status: 'COMPLETED',
            }),
          },
        }),
      );

      await expect(
        service.checkAndReserve('key-abc', 'user-1', '/transactions', { a: 1 }),
      ).rejects.toThrow(ConflictException);
    });

    it('retries on TransactionWriteConflict up to maxRetries then succeeds', async () => {
      let attempts = 0;
      db.withSerializableTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Transaction failed due to a write conflict or a deadlock');
        }
        return cb({
          idempotencyKey: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'key-1', status: 'PROCESSING' }),
          },
        });
      });

      const result = await service.checkAndReserve('key-retry', 'user-1', '/transactions', {});
      expect(attempts).toBe(2);
      expect(result.isNew).toBe(true);
    });
  });

  describe('markCompleted', () => {
    it('updates the key with COMPLETED status and the response payload', async () => {
      await service.markCompleted('key-1', 'txn-1', { status: 201, body: { ok: true } });
      expect(db.idempotencyKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({ status: 'COMPLETED', transactionId: 'txn-1' }) as unknown,
        }),
      );
    });
  });

  describe('markFailed', () => {
    it('updates the key with FAILED status and the error message', async () => {
      await service.markFailed('key-1', 'Something went wrong');
      expect(db.idempotencyKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'key-1' },
          data: expect.objectContaining({ status: 'FAILED' }) as unknown,
        }),
      );
    });
  });

  describe('cleanupStaleKeys', () => {
    it('marks stale PROCESSING keys as FAILED and returns the count', async () => {
      db.idempotencyKey.updateMany.mockResolvedValue({ count: 3 });
      const result = await service.cleanupStaleKeys();
      expect(result).toBe(3);
      expect(db.idempotencyKey.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'FAILED' },
        }),
      );
    });

    it('returns 0 when there are no stale keys', async () => {
      db.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });
      const result = await service.cleanupStaleKeys();
      expect(result).toBe(0);
    });
  });
});
