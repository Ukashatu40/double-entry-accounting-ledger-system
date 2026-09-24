// seeds/transaction-limits.seed.ts
//
// Illustrative CBN Tiered-KYC-inspired demo data: three test NGN wallets
// (one per KycTier) plus TransactionLimit rows for NIP_TRANSFER and
// USSD_TRANSFER, so the tiered-limit enforcement mechanism
// (TransactionLimitService) has something real to check against out of the
// box. A full customer-onboarding-triggered seeding flow (deriving a
// TransactionLimit row automatically whenever an account's kycTier
// metadata is set) is out of scope here — see ADR-008.
import type { PrismaClient } from '@prisma/client';
import { KycTier, KYC_TIER_LIMITS } from '../src/common/types/kyc-tier.type';

const TEST_WALLETS: { code: string; name: string; tier: KycTier }[] = [
  { code: 'TEST-NGN-TIER1', name: 'Test NGN Wallet – KYC Tier 1', tier: KycTier.TIER_1 },
  { code: 'TEST-NGN-TIER2', name: 'Test NGN Wallet – KYC Tier 2', tier: KycTier.TIER_2 },
  { code: 'TEST-NGN-TIER3', name: 'Test NGN Wallet – KYC Tier 3', tier: KycTier.TIER_3 },
];

const LIMIT_TRANSACTION_TYPES = ['NIP_TRANSFER', 'USSD_TRANSFER'] as const;

export async function seedTransactionLimits(prisma: PrismaClient): Promise<void> {
  console.log('🌱 Seeding illustrative KYC-tier NGN test wallets + transaction limits...');

  for (const wallet of TEST_WALLETS) {
    const account = await prisma.account.upsert({
      where: { code: wallet.code },
      update: {},
      create: {
        code: wallet.code,
        name: wallet.name,
        type: 'ASSET',
        subType: 'CURRENT_ASSET',
        currency: 'NGN',
        status: 'ACTIVE',
        description: `Illustrative demo wallet at ${wallet.tier} — see ADR-008.`,
        metadata: { kycTier: wallet.tier },
      },
    });

    const tierLimits = KYC_TIER_LIMITS[wallet.tier];

    for (const transactionType of LIMIT_TRANSACTION_TYPES) {
      const existing = await prisma.transactionLimit.findUnique({
        where: { accountId_transactionType: { accountId: account.id, transactionType } },
      });
      if (existing) continue;

      await prisma.transactionLimit.create({
        data: {
          accountId: account.id,
          transactionType,
          maxPerTx: tierLimits.maxPerTx,
          maxPerDay: tierLimits.maxPerDay,
          maxPerMonth: tierLimits.maxPerMonth,
          currency: 'NGN',
          isActive: true,
        },
      });
      console.log(`  ✅ TransactionLimit for ${wallet.code} / ${transactionType} (${wallet.tier})`);
    }
  }

  console.log('📏 Transaction limits seeded\n');
}
