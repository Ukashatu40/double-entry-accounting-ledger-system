// src/transactions/handlers/reward-redemption.handler.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { BaseTransactionHandler } from './base-transaction.handler';
import { computeBalancingLeg } from './balancing-leg.util';
import type { Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Transaction Type #19 — Reward Points Redemption
 *
 * Correct journal pattern (Table A1.1 + ADR-007):
 *   DEBIT  2030  Rewards Points Liability  [INR equivalent]  (Liability decrease — already correct pre-fix)
 *   DEBIT  1001  Customer Wallet            [INR equivalent]  (Asset increase — customer receives credit)
 *   CREDIT 1050  Platform Operating Cash    [plug — see balancing-leg.util.ts]
 *
 * NOTE on prior bug: the Rewards Liability leg was already correctly
 * signed. Only the wallet leg was backwards (previously CREDITed,
 * decreasing balance, when the customer is receiving the redemption
 * value). See docs/architecture/ADR-007-platform-operating-cash.md.
 *
 * Redemption rate: 1 point = INR 0.25
 * Minimum redemption: 100 points (INR 25)
 *
 * No balance check — reduces a liability and increases an asset.
 */
@Injectable()
export class RewardRedemptionHandler extends BaseTransactionHandler {
  private static readonly POINTS_TO_INR = new Decimal('0.25');
  private static readonly MIN_POINTS = 100;

  protected requiresPlatformOperatingCash(): boolean {
    return true;
  }

  protected validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void> {
    const wallet = this.requireAccount(accounts, 'wallet');

    if (wallet.status !== 'ACTIVE') {
      throw new UnprocessableEntityException('Customer wallet is not active');
    }

    const points = parseInt(String(payload['pointsRedeemed'] ?? '0'), 10);
    if (points < RewardRedemptionHandler.MIN_POINTS) {
      throw new UnprocessableEntityException(
        `Minimum redemption is ${RewardRedemptionHandler.MIN_POINTS.toString()} points`,
      );
    }

    return Promise.resolve();
  }

  protected buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto {
    const rewardsLiability = this.requireAccount(accounts, 'rewardsLiability');
    const wallet = this.requireAccount(accounts, 'wallet');
    const platformCash = this.requireAccount(accounts, 'platformOperatingCash');

    const points = new Decimal(String(payload['pointsRedeemed'] ?? '0'));
    const inrValue = points
      .times(RewardRedemptionHandler.POINTS_TO_INR)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    const currency = 'INR';
    const effectiveDate = String(payload['effectiveDate'] ?? new Date().toISOString());

    const realLines = [
      {
        accountId: rewardsLiability.id,
        entryType: 'DEBIT' as const,
        amount: inrValue.toFixed(4),
        currency,
        narrative: `Reward redemption — ${points.toFixed(0)} points @ INR 0.25`,
      },
      {
        accountId: wallet.id,
        entryType: 'DEBIT' as const,
        amount: inrValue.toFixed(4),
        currency,
        narrative: `Reward points redeemed — INR ${inrValue.toFixed(4)} credited`,
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
            narrative: `Reward redemption — balancing leg (see ADR-007)`,
          },
        ]
      : realLines;

    return {
      referenceType: 'REWARD_REDEMPTION',
      referenceId: transactionId,
      effectiveDate,
      lines,
    };
  }

  protected getBalanceCheckAccounts(): string[] {
    return [];
  }
}
