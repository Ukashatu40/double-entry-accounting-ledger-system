// tests/unit/reversals.controller.spec.ts
import { BadRequestException } from '@nestjs/common';
import { ReversalsController } from '@reversals/reversals.controller';
import type { ReversalsService } from '@reversals/reversals.service';

describe('ReversalsController', () => {
  let controller: ReversalsController;
  let service: jest.Mocked<ReversalsService>;

  beforeEach(() => {
    service = {
      reverseTransaction: jest.fn(),
      partialRefund: jest.fn(),
    } as unknown as jest.Mocked<ReversalsService>;
    controller = new ReversalsController(service);
  });

  describe('fullReversal', () => {
    it('delegates to the service when an idempotency key is provided', async () => {
      service.reverseTransaction.mockResolvedValue({
        reversalId: 'rev-1',
        originalTransactionId: 'orig-1',
        reversalTransactionId: 'rev-txn-1',
        amountReversed: '500.0000',
        feeReversed: '0.0000',
        journalId: 'journal-1',
        postedAt: new Date().toISOString(),
      });

      const dto = { originalTransactionId: 'orig-1', reason: 'Test reason here' };
      const result = await controller.fullReversal(dto, 'test-actor', 'idem-1');
      expect(result.reversalId).toBe('rev-1');
    });

    it('throws BadRequestException without an idempotency key', async () => {
      const dto = { originalTransactionId: 'orig-1', reason: 'Test reason here' };
      await expect(controller.fullReversal(dto, 'test-actor', undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('partialRefund', () => {
    it('delegates to the service when an idempotency key is provided', async () => {
      service.partialRefund.mockResolvedValue({
        reversalId: 'rev-2',
        originalTransactionId: 'orig-1',
        reversalTransactionId: 'rev-txn-2',
        amountReversed: '300.0000',
        feeReversed: '5.0000',
        journalId: 'journal-2',
        postedAt: new Date().toISOString(),
      });

      const dto = {
        originalTransactionId: 'orig-1',
        refundAmount: '300.0000',
        feePolicy: 'PROPORTIONAL',
        reason: 'Test reason',
      } as never;
      const result = await controller.partialRefund(dto, 'test-actor', 'idem-2');
      expect(result.amountReversed).toBe('300.0000');
    });

    it('throws BadRequestException without an idempotency key', async () => {
      const dto = {
        originalTransactionId: 'orig-1',
        refundAmount: '300.0000',
        feePolicy: 'NONE',
        reason: 'Test',
      } as never;
      await expect(controller.partialRefund(dto, 'test-actor', undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
