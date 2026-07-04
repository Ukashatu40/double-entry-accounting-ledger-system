// tests/unit/ledger.controller.spec.ts
import { LedgerController } from '@ledger/ledger.controller';
import type { LedgerService } from '@ledger/ledger.service';
import type { LedgerEntry } from '@prisma/client';

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'entry-1',
    journalId: 'journal-1',
    accountId: 'acc-1',
    entryType: 'DEBIT',
    amount: '1000.0000' as unknown as LedgerEntry['amount'],
    currency: 'INR',
    status: 'POSTED',
    effectiveDate: new Date(),
    postedAt: new Date(),
    createdBy: 'test',
    idempotencyKey: null,
    referenceType: 'CUSTOMER_DEPOSIT_BANK',
    referenceId: 'ref-1',
    narrative: 'Test',
    hash: 'a'.repeat(64),
    previousHash: '0'.repeat(64),
    metadata: null,
    ...overrides,
  } as LedgerEntry;
}

describe('LedgerController', () => {
  let controller: LedgerController;
  let service: jest.Mocked<LedgerService>;

  beforeEach(() => {
    service = {
      postJournalEntry: jest.fn(),
      getJournalEntries: jest.fn(),
      getAccountEntries: jest.fn(),
      getAccountBalance: jest.fn(),
    } as unknown as jest.Mocked<LedgerService>;
    controller = new LedgerController(service);
  });

  it('postJournalEntry() delegates to the service and maps the response', async () => {
    service.postJournalEntry.mockResolvedValue({
      journalId: 'journal-1',
      entries: [makeEntry()],
      totalDebits: '1000.0000',
      totalCredits: '1000.0000',
      postedAt: new Date().toISOString(),
    });

    const dto = {
      referenceType: 'CUSTOMER_DEPOSIT_BANK',
      referenceId: 'ref-1',
      effectiveDate: new Date().toISOString(),
      lines: [],
    } as never;
    const result = (await controller.postJournalEntry(dto, 'test-actor', 'idem-key')) as {
      journalId: string;
      totalDebits: string;
    };

    expect(result.journalId).toBe('journal-1');
    expect(result.totalDebits).toBe('1000.0000');
  });

  it('getJournal() returns mapped entries for a journal ID', async () => {
    service.getJournalEntries.mockResolvedValue([makeEntry(), makeEntry({ id: 'entry-2' })]);
    const result = await controller.getJournal('journal-1');
    expect(result).toHaveLength(2);
  });

  it('getAccountEntries() passes through optional from/to date filters', async () => {
    service.getAccountEntries.mockResolvedValue([makeEntry()]);
    await controller.getAccountEntries('acc-1', '2026-01-01', '2026-12-31');
    expect(service.getAccountEntries).toHaveBeenCalledWith(
      'acc-1',
      new Date('2026-01-01'),
      new Date('2026-12-31'),
    );
  });

  it('getAccountEntries() works with no date filters at all', async () => {
    service.getAccountEntries.mockResolvedValue([]);
    await controller.getAccountEntries('acc-1');
    expect(service.getAccountEntries).toHaveBeenCalledWith('acc-1', undefined, undefined);
  });

  it('getBalance() returns the account balance with a timestamp', async () => {
    service.getAccountBalance.mockResolvedValue('5000.0000');
    const result = (await controller.getBalance('acc-1')) as { accountId: string; balance: string };
    expect(result.accountId).toBe('acc-1');
    expect(result.balance).toBe('5000.0000');
  });
});
