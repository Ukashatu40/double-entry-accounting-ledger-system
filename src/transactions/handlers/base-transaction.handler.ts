// src/transactions/handlers/base-transaction.handler.ts
import { UnprocessableEntityException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import type { LedgerService, PostedJournal } from '@ledger/ledger.service';
import type { AccountsRepository } from '@accounts/accounts.repository';
import type { TransactionType, Account } from '@prisma/client';
import type { CreateJournalEntryDto } from '@ledger/dto/create-journal-entry.dto';

/**
 * Context passed into every transaction handler.
 * Contains all injected services so handlers don't need their own constructors.
 */
export interface TransactionContext {
  ledger: LedgerService;
  accounts: AccountsRepository;
  actor: string;
  idempotencyKey?: string; // was: idempotencyKey: string — must be optional
}

/**
 * The result of processing any transaction type.
 */
export interface TransactionResult {
  transactionId: string;
  type: TransactionType;
  journal: PostedJournal;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract base class for all 20 transaction type handlers.
 *
 * Each handler is responsible for:
 *   1. Validating its own business rules (limits, KYC, eligibility)
 *   2. Building the correct journal entry DTO for its transaction type
 *   3. Specifying which accounts need balance checks before debiting
 *
 * The base class handles:
 *   - Calling the ledger service to post the journal
 *   - Generating the transaction ID
 *   - Consistent error wrapping
 *
 * This separation means the LedgerService stays generic and the
 * accounting rules stay in their respective handlers — single responsibility.
 */
export abstract class BaseTransactionHandler {
  /**
   * Build the journal entry DTO for this transaction type.
   *
   * IMPORTANT: derive the debit/credit pattern from Table A1.1 (Asset:
   * Debit=Increase/Credit=Decrease, etc.) and the spec's worked examples
   * (A1.3, A3.2, A5.1) — NOT from Section A4.2's abbreviated "Journal
   * Pattern" column, which contradicts Table A1.1 for several transaction
   * types and was the root cause of a real bug fixed under ADR-007. When a
   * Revenue/Expense leg is involved alongside a wallet movement, use
   * computeBalancingLeg() (balancing-leg.util.ts) rather than hand-deriving
   * a residual amount.
   */
  protected abstract buildJournalEntry(
    transactionId: string,
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): CreateJournalEntryDto;

  /**
   * Return the account IDs that need a balance check before this transaction
   * can proceed. Empty array = no balance check (for funding transactions).
   */
  protected abstract getBalanceCheckAccounts(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): string[];

  /**
   * Validate business rules specific to this transaction type.
   * Throw UnprocessableEntityException if validation fails.
   */
  protected abstract validateBusinessRules(
    payload: Record<string, unknown>,
    accounts: Record<string, Account>,
  ): Promise<void>;

  /**
   * Override to `true` for any handler whose buildJournalEntry() needs the
   * "1050 – Platform Operating Cash" clearing account (see ADR-007 and
   * balancing-leg.util.ts for why this is unavoidable for fee/expense-
   * splitting transactions). When true, execute() resolves the account
   * automatically and injects it into accountMap under the key
   * "platformOperatingCash" — callers never need to supply this account ID
   * themselves; it is a system account, not a caller-selectable one.
   */
  protected requiresPlatformOperatingCash(): boolean {
    return false;
  }

  /**
   * Execute the transaction.
   * Called by TransactionsService after idempotency is checked.
   */
  async execute(
    payload: Record<string, unknown>,
    accountMap: Record<string, Account>,
    ctx: TransactionContext,
  ): Promise<TransactionResult> {
    const transactionId = uuidv7();

    if (this.requiresPlatformOperatingCash() && !accountMap.platformOperatingCash) {
      accountMap = {
        ...accountMap,
        platformOperatingCash: await ctx.accounts.findByCode('1050'),
      };
    }

    await this.validateBusinessRules(payload, accountMap);

    const dto = this.buildJournalEntry(transactionId, payload, accountMap);
    const balanceCheckAccounts = this.getBalanceCheckAccounts(payload, accountMap);

    const journal = await ctx.ledger.postJournalEntry(dto, ctx.actor, ctx.idempotencyKey, {
      checkBalanceOn: balanceCheckAccounts,
    });

    return { transactionId, type: dto.referenceType, journal };
  }

  protected requireAccount(accountMap: Record<string, Account>, key: string): Account {
    const account = accountMap[key];
    if (!account) {
      throw new UnprocessableEntityException(`Required account "${key}" not found`);
    }
    return account;
  }
}
