// src/transactions/handlers/p2p-transfer.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #4 — P2P Transfer with fee
 *
 * Correct journal pattern (Table A1.1 + ADR-007 — see balancing-leg.util.ts
 * for the full derivation of why a Platform Operating Cash leg is required):
 *   CREDIT 1001-A  Sender Wallet             [amount + fee]  (Asset decrease)
 *   DEBIT  1001-B  Recipient Wallet          [amount]        (Asset increase)
 *   CREDIT 4001    Transaction Fee Revenue   [fee]           (Revenue increase)
 *   DEBIT  1050    Platform Operating Cash   [amount + 2·fee − amount] (plug)
 *
 * NOTE on prior bug: this handler previously matched spec A4.2's abbreviated
 * table (DEBIT sender / CREDIT recipient), which is backwards relative to
 * Table A1.1 and the spec's own A1.3 worked example — DEBITing an Asset
 * account *increases* it, so the old code made a sender's balance go UP
 * when they sent money. See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Balance check: sender wallet must have amount + fee available (see
 * getBalanceCheckAccounts — this now works correctly because the sender's
 * derived balance actually decreases on send, closing the double-spend gap
 * the polarity bug created).
 */
@Injectable()
export class P2pTransferHandler extends BaseTransactionHandler {
  private static readonly MAX_TRANSFER = '200000.0000'; // INR 2 lakh per transfer
  private static readonly TRANSFER_FEE = '10.0000'; // INR 10 flat fee

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

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    if (amount.gt(new Decimal(P2pTransferHandler.MAX_TRANSFER))) {
      throw new UnprocessableEntityException(
        `Transfer amount exceeds limit of ${P2pTransferHandler.MAX_TRANSFER}`,
      );
    }

    return Promise.resolve();
  }

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  // Retrofit example proving TransactionLimitService/getLimitCheckSpecs()
  // (see base-transaction.handler.ts) is genuinely generic, not an
  // NGN-only mechanism introduced alongside nip-transfer/ussd-transfer.
  protected getLimitCheckSpecs(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): { accountId: string; amount: string }[] {
    const senderWallet = accounts['senderWallet'];
    if (!senderWallet) return [];

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const totalDebit = amount
      .plus(P2pTransferHandler.TRANSFER_FEE)
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
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const amount = new Decimal(String(payload['amount'] ?? '0'));
    const currency = String(payload['currency'] ?? 'INR');
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());
    const fee = new Decimal(P2pTransferHandler.TRANSFER_FEE);

    // Total sender debit (economic, informational) = amount + fee
    const totalDebit = amount.plus(fee).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

    // "Real" lines — each entryType is correct per Table A1.1 for its own account.
    const realLines = [
      {
        accountId: senderWallet.id,
        entryType: 'CREDIT' as const,
        amount: totalDebit,
        currency,
        narrative: `P2P transfer sent — amount ${amount.toFixed(4)} + fee ${fee.toFixed(4)}`,
      },
      {
        accountId: recipientWallet.id,
        entryType: 'DEBIT' as const,
        amount: amount.toFixed(4),
        currency,
        narrative: `P2P transfer received from ${senderWallet.id}`,
      },
      {
        accountId: feeRevenue.id,
        entryType: 'CREDIT' as const,
        amount: fee.toFixed(4),
        currency,
        narrative: `P2P transfer fee`,
      },
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
            narrative: `P2P transfer — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'P2P_TRANSFER',
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
