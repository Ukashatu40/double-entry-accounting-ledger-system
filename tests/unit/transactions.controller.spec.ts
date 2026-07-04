// tests/unit/transactions.controller.spec.ts
import { BadRequestException } from '@nestjs/common';
import { TransactionsController } from '@transactions/transactions.controller';
import type { TransactionsService } from '@transactions/transactions.service';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let service: jest.Mocked<TransactionsService>;

  beforeEach(() => {
    service = { process: jest.fn() } as unknown as jest.Mocked<TransactionsService>;
    controller = new TransactionsController(service);
  });

  it('processes a transaction and returns a summarised response', async () => {
    service.process.mockResolvedValue({
      transactionId: 'txn-1',
      type: 'CUSTOMER_DEPOSIT_BANK',
      journal: {
        journalId: 'journal-1',
        entries: [{}, {}] as never,
        totalDebits: '1000.0000',
        totalCredits: '1000.0000',
        postedAt: new Date().toISOString(),
      },
    });

    const dto = {
      type: 'CUSTOMER_DEPOSIT_BANK',
      effectiveDate: new Date().toISOString(),
      payload: {},
    } as never;
    const result = (await controller.process(dto, 'test-actor', 'idem-key-1')) as {
      transactionId: string;
      entries: number;
    };

    expect(result.transactionId).toBe('txn-1');
    expect(result.entries).toBe(2);
  });

  it('throws BadRequestException when the idempotency key header is missing', async () => {
    const dto = {
      type: 'CUSTOMER_DEPOSIT_BANK',
      effectiveDate: new Date().toISOString(),
      payload: {},
    } as never;
    await expect(controller.process(dto, 'test-actor', undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(service.process).not.toHaveBeenCalled();
  });
});
