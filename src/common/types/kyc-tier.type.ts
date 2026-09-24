// src/common/types/kyc-tier.type.ts

/**
 * Illustrative CBN Tiered-KYC-inspired account tiers — modeled on the
 * public Central Bank of Nigeria Tier 1/2/3 KYC framework for demonstration
 * purposes (NOT a compliance-certified implementation; real onboarding
 * would require actual BVN/NIN verification and CBN sign-off).
 *
 * Stored under Account.metadata.kycTier (see AccountMetadata below) — this
 * is a classification used only at account-provisioning time to decide
 * which TransactionLimit rows to create for an account. Runtime enforcement
 * always reads TransactionLimit (src/ledger/transaction-limit.service.ts),
 * never this enum directly.
 */
export enum KycTier {
  /** BVN-only / minimal KYC — lowest caps. */
  TIER_1 = 'TIER_1',
  /** BVN + additional government ID + proof of address. */
  TIER_2 = 'TIER_2',
  /** Full KYC — enhanced due diligence, no cap. */
  TIER_3 = 'TIER_3',
}

/** Shape of the JSON stored in Account.metadata when a tier is assigned. */
export interface AccountMetadata {
  kycTier?: KycTier;
  [key: string]: unknown;
}

/**
 * Illustrative per-tier limits, in the account's own currency. Used only at
 * account/TransactionLimit provisioning time (see seeds/transaction-limits.seed.ts)
 * — never read directly by a handler at transaction time.
 */
export const KYC_TIER_LIMITS: Record<
  KycTier,
  { maxPerTx: string | null; maxPerDay: string | null; maxPerMonth: string | null }
> = {
  [KycTier.TIER_1]: { maxPerTx: '50000.0000', maxPerDay: '50000.0000', maxPerMonth: '200000.0000' },
  [KycTier.TIER_2]: {
    maxPerTx: '200000.0000',
    maxPerDay: '200000.0000',
    maxPerMonth: '5000000.0000',
  },
  // NULL = no limit, matching TransactionLimit's own convention for an
  // absent cap (prisma/schema.prisma: maxPerTx/maxPerDay/maxPerMonth are
  // all nullable "NULL = no limit").
  [KycTier.TIER_3]: { maxPerTx: null, maxPerDay: null, maxPerMonth: null },
};
