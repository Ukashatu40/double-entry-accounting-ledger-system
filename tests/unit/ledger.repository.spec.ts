// tests/unit/ledger.repository.spec.ts
import { LedgerRepository } from '@ledger/ledger.repository';
import type { DatabaseService } from '@database/database.service';

function makeMockDb() {
  return {
    ledgerEntry: { findMany: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
  };
}

describe('LedgerRepository', () => {
  let repo: LedgerRepository;
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
    repo = new LedgerRepository(db as unknown as DatabaseService);
  });

  describe('findByAccountId', () => {
    it('queries with no date filters when neither from nor to is given', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findByAccountId('acc-1');
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.effectiveDate).toBeUndefined();
    });

    it('queries with only a from-date filter', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findByAccountId('acc-1', new Date('2026-01-01'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.effectiveDate.gte).toEqual(new Date('2026-01-01'));
      expect(where.effectiveDate.lte).toBeUndefined();
    });

    it('queries with only a to-date filter', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findByAccountId('acc-1', undefined, new Date('2026-12-31'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.effectiveDate.lte).toEqual(new Date('2026-12-31'));
      expect(where.effectiveDate.gte).toBeUndefined();
    });

    it('queries with both from and to date filters', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findByAccountId('acc-1', new Date('2026-01-01'), new Date('2026-12-31'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.effectiveDate.gte).toEqual(new Date('2026-01-01'));
      expect(where.effectiveDate.lte).toEqual(new Date('2026-12-31'));
    });
  });

  describe('findAllForVerification', () => {
    it('queries with no date filters by default', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findAllForVerification();
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.postedAt).toBeUndefined();
    });

    it('queries with only a from-date', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findAllForVerification(new Date('2026-01-01'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.postedAt.gte).toEqual(new Date('2026-01-01'));
    });

    it('queries with only a to-date', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findAllForVerification(undefined, new Date('2026-12-31'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.postedAt.lte).toEqual(new Date('2026-12-31'));
    });

    it('queries with both from and to dates', async () => {
      db.ledgerEntry.findMany.mockResolvedValue([]);
      await repo.findAllForVerification(new Date('2026-01-01'), new Date('2026-12-31'));
      const where = db.ledgerEntry.findMany.mock.calls[0][0].where;
      expect(where.postedAt.gte).toEqual(new Date('2026-01-01'));
      expect(where.postedAt.lte).toEqual(new Date('2026-12-31'));
    });
  });

  describe('insertEntry', () => {
    it('includes idempotencyKey in the create payload when provided', async () => {
      db.ledgerEntry.create.mockResolvedValue({});
      const tx = { ledgerEntry: { create: db.ledgerEntry.create } };
      await repo.insertEntry(tx as never, {
        id: 'e1',
        journalId: 'j1',
        accountId: 'a1',
        entryType: 'DEBIT',
        amount: '100.0000',
        currency: 'INR',
        effectiveDate: new Date(),
        createdBy: 'test',
        idempotencyKey: 'idem-1',
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: 'r1',
        narrative: 'n',
        hash: 'h',
        previousHash: 'p',
      });
      expect(db.ledgerEntry.create.mock.calls[0][0].data.idempotencyKey).toBe('idem-1');
    });

    it('includes metadata in the create payload when provided', async () => {
      db.ledgerEntry.create.mockResolvedValue({});
      const tx = { ledgerEntry: { create: db.ledgerEntry.create } };
      await repo.insertEntry(tx as never, {
        id: 'e1',
        journalId: 'j1',
        accountId: 'a1',
        entryType: 'DEBIT',
        amount: '100.0000',
        currency: 'INR',
        effectiveDate: new Date(),
        createdBy: 'test',
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: 'r1',
        narrative: 'n',
        hash: 'h',
        previousHash: 'p',
        metadata: { key: 'value' },
      });
      expect(db.ledgerEntry.create.mock.calls[0][0].data.metadata).toEqual({ key: 'value' });
    });

    it('omits idempotencyKey and metadata fields when not provided', async () => {
      db.ledgerEntry.create.mockResolvedValue({});
      const tx = { ledgerEntry: { create: db.ledgerEntry.create } };
      await repo.insertEntry(tx as never, {
        id: 'e1',
        journalId: 'j1',
        accountId: 'a1',
        entryType: 'DEBIT',
        amount: '100.0000',
        currency: 'INR',
        effectiveDate: new Date(),
        createdBy: 'test',
        referenceType: 'CUSTOMER_DEPOSIT_BANK',
        referenceId: 'r1',
        narrative: 'n',
        hash: 'h',
        previousHash: 'p',
      });
      const data = db.ledgerEntry.create.mock.calls[0][0].data;
      expect('idempotencyKey' in data).toBe(false);
      expect('metadata' in data).toBe(false);
    });
  });
});
