// src/transactions/handlers/ussd-transfer.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import { computeStampDuty } from './stamp-duty.util';
import { computeVat, computeCybersecurityLevy } from './nigeria-levies.util';
import { requireSupportedCurrency } from './payload-validation.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * USSD Transfer — Nigeria's *737#-style USSD banking channel. Same journal
 * shape as NIP_TRANSFER (see nip-transfer.handler.ts), demonstrating that
 * the handler-per-transaction-type extension pattern is trivially
 * repeatable. USSD has a lower illustrative transfer ceiling than NIP,
 * reflecting the channel's real-world cap for feature-phone/offline banking.
 */
@Injectable()
export class UssdTransferHandler extends BaseTransactionHandler {
  private static readonly MAX_TRANSFER = '100000.0000'; // ₦100,000 illustrative USSD channel cap
  private static readonly USSD_FEE = '10.0000'; // illustrative flat USSD transfer fee

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
      throw new UnprocessableEntityException('USSD_TRANSFER only supports NGN transfers');
    }

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    if (amount.lte(0)) {
      throw new UnprocessableEntityException('Transfer amount must be positive');
    }
    if (amount.gt(new Decimal(UssdTransferHandler.MAX_TRANSFER))) {
      throw new UnprocessableEntityException(
        `Transfer amount exceeds USSD channel limit of ${UssdTransferHandler.MAX_TRANSFER}`,
      );
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected additionalSystemAccounts(): Record<string, string> {
    return { stampDutyPayable: '2041', vatPayable: '2040', cybersecurityLevyPayable: '2042' };
  }

  protected getLimitCheckSpecs(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): { accountId: string; amount: string }[] {
    const senderWallet = accounts['senderWallet'];
    if (!senderWallet) return [];

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'NGN');
    const fee = new Decimal(UssdTransferHandler.USSD_FEE);
    const totalDebit = amount
      .plus(fee)
      .plus(computeStampDuty(amount, currency))
      .plus(computeVat(fee, currency))
      .plus(computeCybersecurityLevy(amount, currency))
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
    const vatPayable = this.requireAccount(accounts, 'vatPayable');
    const cybersecurityLevyPayable = this.requireAccount(accounts, 'cybersecurityLevyPayable');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'NGN');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const fee = new Decimal(UssdTransferHandler.USSD_FEE);
    const stampDuty = computeStampDuty(amount, currency);
    const vat = computeVat(fee, currency);
    const cybersecurityLevy = computeCybersecurityLevy(amount, currency);

    const totalDebit = amount
      .plus(fee)
      .plus(stampDuty)
      .plus(vat)
      .plus(cybersecurityLevy)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4);

    const realLines = [
      {
        accountId: senderWallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative:
          `USSD transfer sent — amount ${amount.toFixed(4)} + fee ${fee.toFixed(4)}` +
          (stampDuty.gt(0) ? ` + stamp duty ${stampDuty.toFixed(4)}` : '') +
          (vat.gt(0) ? ` + VAT ${vat.toFixed(4)}` : '') +
          (cybersecurityLevy.gt(0) ? ` + cybersecurity levy ${cybersecurityLevy.toFixed(4)}` : ''),
      },
      {
        accountId: recipientWallet.id,
        entryType: 'DEBIT' as const,
        amount: amount.toFixed(4),
        currency,
        narrative: `USSD transfer received from ${senderWallet.id}`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: fee.toFixed(4),
        currency,
        narrative: `USSD transfer fee`,
      },
      ...(stampDuty.gt(0)
        ? [
            {
              accountId: stampDutyPayable.id,
              entryType: 'CREDIT' as const,
              amount: stampDuty.toFixed(4),
              currency,
              narrative: `USSD transfer — Finance Act stamp duty (₦50 on transfers ≥ ₦10,000)`,
            },
          ]
        : []),
      ...(vat.gt(0)
        ? [
            {
              accountId: vatPayable.id,
              entryType: 'CREDIT' as const,
              amount: vat.toFixed(4),
              currency,
              narrative: `USSD transfer — VAT (7.5% of fee)`,
            },
          ]
        : []),
      ...(cybersecurityLevy.gt(0)
        ? [
            {
              accountId: cybersecurityLevyPayable.id,
              entryType: 'CREDIT' as const,
              amount: cybersecurityLevy.toFixed(4),
              currency,
              narrative: `USSD transfer — CBN Cybersecurity Levy (0.005% of amount)`,
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
            narrative: `USSD transfer — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'USSD_TRANSFER',
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
