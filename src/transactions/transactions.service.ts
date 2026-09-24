// src/transactions/transactions.service.ts
import {
  Injectable,
  Logger,
  //   UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { LedgerService } from '@ledger/ledger.service';
import { AccountsRepository } from '@accounts/accounts.repository';
import { IdempotencyService } from './idempotency.service';
import { DepositBankHandler } from './handlers/deposit-bank.handler';
import { WithdrawalHandler } from './handlers/withdrawal.handler';
import { P2pTransferHandler } from './handlers/p2p-transfer.handler';
import { FeeDeductionHandler } from './handlers/fee-deduction.handler';
import { MerchantPaymentQrHandler } from './handlers/merchant-payment-qr.handler';
import { MerchantPaymentOnlineHandler } from './handlers/merchant-payment-online.handler';
import { BillPaymentHandler } from './handlers/bill-payment.handler';
import { InterestAccrualHandler } from './handlers/interest-accrual.handler';
import { DepositCardHandler } from './handlers/deposit-card.handler';
import { InterestPayoutHandler } from './handlers/interest-payout.handler';
import { CashbackCreditHandler } from './handlers/cashback-credit.handler';
import { PromotionalCreditHandler } from './handlers/promotional-credit.handler';
import { LoanDisbursementHandler } from './handlers/loan-disbursement.handler';
import { LoanEmiPaymentHandler } from './handlers/loan-emi-payment.handler';
import { FxConversionHandler } from './handlers/fx-conversion.handler';
import { RefundFullHandler } from './handlers/refund-full.handler';
import { RefundPartialHandler } from './handlers/refund-partial.handler';
import { ChargebackHandler } from './handlers/chargeback.handler';
import { RewardRedemptionHandler } from './handlers/reward-redemption.handler';
import { AccountClosureHandler } from './handlers/account-closure.handler';
import { NipTransferHandler } from './handlers/nip-transfer.handler';
import { UssdTransferHandler } from './handlers/ussd-transfer.handler';

import type {
  BaseTransactionHandler,
  TransactionResult,
  TransactionContext,
} from './handlers/base-transaction.handler';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { TransactionType } from '@prisma/client';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  // Handler registry — one entry per transaction type
  // New handlers are registered here as we build them
  private readonly handlers: Partial<Record<TransactionType, BaseTransactionHandler>>;

  constructor(
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly fxConversionHandler: FxConversionHandler, // ← DI-injected
  ) {
    this.handlers = {
      CUSTOMER_DEPOSIT_BANK: new DepositBankHandler(),
      CUSTOMER_DEPOSIT_CARD: new DepositCardHandler(),
      CUSTOMER_WITHDRAWAL_BANK: new WithdrawalHandler(),
      P2P_TRANSFER: new P2pTransferHandler(),
      MERCHANT_PAYMENT_QR: new MerchantPaymentQrHandler(),
      MERCHANT_PAYMENT_ONLINE: new MerchantPaymentOnlineHandler(),
      BILL_PAYMENT: new BillPaymentHandler(),
      INTEREST_ACCRUAL: new InterestAccrualHandler(),
      INTEREST_PAYOUT: new InterestPayoutHandler(),
      FEE_DEDUCTION_MONTHLY: new FeeDeductionHandler(),
      CASHBACK_CREDIT: new CashbackCreditHandler(),
      PROMOTIONAL_CREDIT: new PromotionalCreditHandler(),
      LOAN_DISBURSEMENT: new LoanDisbursementHandler(),
      LOAN_EMI_PAYMENT: new LoanEmiPaymentHandler(),
      FX_CONVERSION: this.fxConversionHandler, // ← use injected instance, not `new`
      REFUND_FULL: new RefundFullHandler(),
      REFUND_PARTIAL: new RefundPartialHandler(),
      CHARGEBACK: new ChargebackHandler(),
      REWARD_REDEMPTION: new RewardRedemptionHandler(),
      ACCOUNT_CLOSURE_SWEEP: new AccountClosureHandler(),
      NIP_TRANSFER: new NipTransferHandler(),
      USSD_TRANSFER: new UssdTransferHandler(),
    };
  }

  async process(
    dto: CreateTransactionDto,
    actor: string,
    idempotencyKey?: string,
    userId?: string,
  ): Promise<TransactionResult> {
    const handler = this.handlers[dto.type];
    if (!handler) {
      throw new BadRequestException(`Transaction type ${dto.type} is not yet implemented`);
    }

    // ── Idempotency check ────────────────────────────────────────────────────
    let idempotencyKeyRecord:
      Awaited<ReturnType<IdempotencyService['checkAndReserve']>>['keyRecord'] | undefined;

    if (idempotencyKey !== undefined) {
      const effectiveUserId = userId ?? actor;
      const { isNew, keyRecord } = await this.idempotency.checkAndReserve(
        idempotencyKey,
        effectiveUserId,
        `/transactions/${dto.type}`,
        dto,
      );

      if (!isNew) {
        if (keyRecord.status === 'COMPLETED' && keyRecord.responseBody !== null) {
          this.logger.log(`Replaying idempotent response for key ${idempotencyKey}`);
          return keyRecord.responseBody as unknown as TransactionResult;
        }
      }

      idempotencyKeyRecord = keyRecord;
    }

    // ── Resolve account map from payload ────────────────────────────────────
    // Each handler's payload should contain account IDs or codes
    // We resolve them here and pass the full Account objects to the handler
    const accountMap = await this.resolveAccounts(dto.payload);

    // ── Execute handler ──────────────────────────────────────────────────────
    let result: TransactionResult;
    try {
      const ctx: TransactionContext = {
        ledger: this.ledger,
        accounts: this.accounts,
        actor,
      };
      if (idempotencyKey !== undefined) ctx.idempotencyKey = idempotencyKey;

      result = await handler.execute(
        { ...dto.payload, effectiveDate: dto.effectiveDate },
        accountMap,
        ctx,
      );
    } catch (error) {
      // Mark idempotency key as failed so client can retry
      if (idempotencyKeyRecord) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.idempotency.markFailed(idempotencyKeyRecord.id, msg);
      }
      throw error;
    }

    // ── Mark idempotency key completed ───────────────────────────────────────
    if (idempotencyKeyRecord) {
      await this.idempotency.markCompleted(idempotencyKeyRecord.id, result.transactionId, {
        status: 201,
        body: result,
      });
    }

    this.logger.log(
      `Transaction processed: type=${dto.type} id=${result.transactionId} actor=${actor}`,
    );

    return result;
  }

  /**
   * Resolve account IDs from the payload.
   * Handlers expect an accountMap with named keys like 'wallet', 'liability', etc.
   * The payload must include those keys with valid account UUIDs as values.
   */
  private async resolveAccounts(
    payload: Record<string, unknown>,
  ): Promise<Record<string, import('@prisma/client').Account>> {
    const accountMap: Record<string, import('@prisma/client').Account> = {};

    // Collect all keys ending in 'AccountId' or 'Id' that look like UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const accountKeys = Object.entries(payload).filter(
      ([key, value]) =>
        (key.endsWith('AccountId') || key.endsWith('WalletId')) &&
        typeof value === 'string' &&
        uuidRegex.test(value),
    );

    if (accountKeys.length === 0) {
      // Try code-based resolution
      const codeKeys = Object.entries(payload).filter(([key]) => key.endsWith('AccountCode'));
      for (const [key, value] of codeKeys) {
        const mapKey = key.replace('AccountCode', '').replace(/([A-Z])/g, (m) => m.toLowerCase());
        const account = await this.accounts.findByCode(String(value));
        accountMap[mapKey] = account;
      }
      return accountMap;
    }

    for (const [key, value] of accountKeys) {
      // walletAccountId → wallet, senderWalletId → senderWallet
      const mapKey = key.replace('AccountId', '').replace('WalletId', 'Wallet');
      const account = await this.accounts.findById(String(value));
      accountMap[mapKey] = account;
    }

    return accountMap;
  }
}
