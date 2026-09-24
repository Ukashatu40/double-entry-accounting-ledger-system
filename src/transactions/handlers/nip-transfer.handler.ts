// src/transactions/handlers/nip-transfer.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { computeStampDuty } from './stamp-duty.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * NIP Transfer — NIBSS Instant Payment, Nigeria's real-time interbank
 * transfer rail (analogous in shape to P2P_TRANSFER, but NGN-only and
 * subject to Nigeria's Finance Act stamp duty on qualifying amounts).
 *
 * Correct journal pattern (Table A1.1 + ADR-007, same shape as
 * p2p-transfer.handler.ts):
 *   CREDIT 1004  Sender Wallet (NGN)       [amount + fee + stampDuty]
 *   DEBIT  1004  Recipient Wallet (NGN)    [amount]
 *   CREDIT 4001  Transaction Fee Revenue   [fee]
 *   CREDIT 2041  Stamp Duty Payable (NGN)  [stampDuty]  (only if amount >= ₦10,000)
 *   DEBIT  1050  Platform Operating Cash   [plug]
 *
 * Fee and limit constants below are illustrative (not live NIBSS tariffs).
 */
@Injectable()
export class NipTransferHandler extends BaseTransactionHandler {
  private static readonly MAX_TRANSFER = '5000000.0000'; // ₦5,000,000 illustrative ceiling
  private static readonly NIP_FEE = '26.8800'; // illustrative flat interbank fee tier

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const senderWallet = this.requireAccount(accounts, 'senderWallet');
    const recipientWallet = this.requireAccount(accounts, 'recipientWallet');

    if (senderWallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(`Sender wallet ${senderWallet.code} is not active`);
    }
    if (recipientWallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException(
        `Recipient wallet ${recipientWallet.code} is not active`,
      );
    }
    if (senderWallet.id === recipientWallet.id) {
      throw new UnprocessableEntityException('Sender and recipient cannot be the same account');
    }

    const currency = requireSupportedCurrency(payload);
    if (currency !== 'NGN') {
      throw new UnprocessableEntityException('NIP_TRANSFER only supports NGN transfers');
    }

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    if (amount.lte(0)) {
      throw new UnprocessableEntityException('Transfer amount must be positive');
    }
    if (amount.gt(new Decimal(NipTransferHandler.MAX_TRANSFER))) {
      throw new UnprocessableEntityException(
        `Transfer amount exceeds limit of ${NipTransferHandler.MAX_TRANSFER}`,
      );
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected additionalSystemAccounts(): Record<string, string> {
    return { stampDutyPayable: '2041' };
  }

  protected getLimitCheckSpecs(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): { accountId: string; amount: string }[] {
    const senderWallet = accounts['senderWallet'];
    if (!senderWallet) return [];

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'NGN');
    const totalDebit = amount
      .plus(NipTransferHandler.NIP_FEE)
      .plus(computeStampDuty(amount, currency))
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4);

    return [{ accountId: senderWallet.id, amount: totalDebit }];
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const senderWallet = this.requireAccount(accounts, 'senderWallet');
    const recipientWallet = this.requireAccount(accounts, 'recipientWallet');
    const feeRevenue = this.requireAccount(accounts, 'feeRevenue');
    const stampDutyPayable = this.requireAccount(accounts, 'stampDutyPayable');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'NGN');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const fee = new Decimal(NipTransferHandler.NIP_FEE);
    const stampDuty = computeStampDuty(amount, currency);

    const totalDebit = amount
      .plus(fee)
      .plus(stampDuty)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4);

    const realLines = [
      {
        accountId: senderWallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative:
          `NIP transfer sent — amount ${amount.toFixed(4)} + fee ${fee.toFixed(4)}` +
          (stampDuty.gt(0) ? ` + stamp duty ${stampDuty.toFixed(4)}` : ''),
      },
      {
        accountId: recipientWallet.id,
        entryType: 'DEBIT' as const,
        amount: amount.toFixed(4),
        currency,
        narrative: `NIP transfer received from ${senderWallet.id}`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: fee.toFixed(4),
        currency,
        narrative: `NIP transfer fee`,
      },
      ...(stampDuty.gt(0)
        ? [
            {
              accountId: stampDutyPayable.id,
              entryType: 'CREDIT' as const,
              amount: stampDuty.toFixed(4),
              currency,
              narrative: `NIP transfer — Finance Act stamp duty (₦50 on transfers ≥ ₦10,000)`,
            },
          ]
        : []),
    ];

    const plug = computeBalancingLeg(realLines);
    const lines = plug
      ? [
          ...realLines,
          {
            accountId: platformCash.id,
            entryType: plug.entryType,
            amount: plug.amount,
            currency,
            narrative: `NIP transfer — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'NIP_TRANSFER',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(
    _payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): string[] {
    const sender = accounts['senderWallet'];
    return sender ? [sender.id] : [];
  }
}
