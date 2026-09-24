// seeds/chart-of-accounts.seed.ts
import type { Prisma, PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Chart of Accounts Definition
//
// Based on the NovaPay neo-banking CoA from spec Part A1.2 (pages 3-5).
// Extended with system accounts needed for hash chain genesis and rounding.
//
// Account code ranges:
//   1xxx — Assets
//   2xxx — Liabilities
//   3xxx — Equity
//   4xxx — Revenue
//   5xxx — Expenses
//   9xxx — System / Control accounts
// ─────────────────────────────────────────────────────────────────────────────

type AccountSeed = Prisma.AccountCreateInput;

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ── ASSETS ────────────────────────────────────────────────────────────────
  {
    code: '1001',
    name: 'Customer Wallet – Primary (INR)',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'INR',
    description: 'Primary INR wallet balance for customer accounts',
  },
  {
    code: '1002',
    name: 'Customer Wallet – USD Holdings',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'USD',
    description: 'USD foreign currency wallet balance for customer accounts',
  },
  {
    code: '1003',
    name: 'Customer Wallet – EUR Holdings',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'EUR',
    description: 'EUR foreign currency wallet balance for customer accounts',
  },
  {
    code: '1010',
    name: 'Merchant Settlement – Pending',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'INR',
    description: 'Funds collected from customers pending settlement to merchants',
  },
  {
    code: '1020',
    name: 'Loan Receivable – Personal',
    type: 'ASSET',
    subType: 'NON_CURRENT_ASSET',
    currency: 'INR',
    description: 'Outstanding principal on personal loans disbursed',
  },
  {
    code: '1030',
    name: 'Interest Receivable – Accrued',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'INR',
    description: 'Interest earned but not yet received on outstanding loans',
  },
  {
    code: '1040',
    name: 'FX Conversion Holding – USD',
    type: 'ASSET',
    subType: 'FX_HOLDING',
    currency: 'USD',
    description: 'Intermediate holding account used during USD FX conversion entries',
  },
  {
    code: '1041',
    name: 'FX Conversion Holding – EUR',
    type: 'ASSET',
    subType: 'FX_HOLDING',
    currency: 'EUR',
    description: 'Intermediate holding account used during EUR FX conversion entries',
  },
  {
    code: '1042',
    name: 'FX Conversion Holding – INR',
    type: 'ASSET',
    subType: 'FX_HOLDING',
    currency: 'INR',
    description:
      'Intermediate holding account used during FX conversion entries (target currency leg)',
  },
  {
    code: '1004',
    name: 'Customer Wallet – NGN Holdings',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'NGN',
    description: 'NGN (Nigerian Naira) foreign currency wallet balance for customer accounts',
  },
  {
    code: '1044',
    name: 'FX Conversion Holding – NGN',
    type: 'ASSET',
    subType: 'FX_HOLDING',
    currency: 'NGN',
    description: 'Intermediate holding account used during NGN FX conversion entries',
  },
  {
    code: '1050',
    name: 'Platform Operating Cash',
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    currency: 'INR',
    description:
      'System clearing account used to balance journal entries that split a single wallet ' +
      'movement across a correctly-signed counterparty leg AND a Revenue/Expense leg (e.g. ' +
      'P2P transfer with a fee, cashback funded from bank operating cash). Not a caller- ' +
      'selectable account — resolved automatically by handlers via requiresPlatformOperatingCash(). ' +
      'See ADR-007 for the derivation of why this account is structurally required.',
  },

  // ── LIABILITIES ───────────────────────────────────────────────────────────
  {
    code: '2001',
    name: 'Customer Deposit Liability',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description: "The platform's liability to customers for their deposited funds (INR)",
  },
  {
    code: '2002',
    name: 'Merchant Payable – Pending',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description: 'Amount owed to merchants pending settlement',
  },
  {
    code: '2010',
    name: 'Interest Payable – Savings',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description: 'Accrued interest owed to customers on savings balances',
  },
  {
    code: '2020',
    name: 'Tax Collected at Source (TCS)',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description: 'TCS collected under Section 206C of IT Act on LRS remittances above INR 7 lakh',
  },
  {
    code: '2030',
    name: 'Rewards Points Liability',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description: 'Liability for unredeemed customer reward points (1 point = INR 0.25)',
  },

  {
    code: '2040',
    name: 'VAT Payable (NGN)',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'NGN',
    description:
      "VAT collected at Nigeria's standard 7.5% rate on transaction fees for NGN-denominated " +
      'transactions, per the Finance Act — illustrative modeling, not a compliance-certified rate feed.',
  },
  {
    code: '2041',
    name: 'Stamp Duty Payable (NGN)',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'NGN',
    description:
      'Flat ₦50 stamp duty on qualifying electronic transfers of ₦10,000 or more, per the ' +
      "Finance Act's stamp duty provisions. See stamp-duty.util.ts.",
  },
  {
    code: '2042',
    name: 'CBN Cybersecurity Levy Payable (NGN)',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'NGN',
    description:
      '0.005% levy on electronic transfers per the Cybercrime (Prohibition, Prevention, etc.) ' +
      'Act as amended, remitted to the National Cybersecurity Fund via CBN. Seeded as a CoA ' +
      'entry only in this change — not yet wired into a transaction handler (see ADR-008).',
  },

  // ── EQUITY ────────────────────────────────────────────────────────────────
  {
    code: '3001',
    name: 'Retained Earnings',
    type: 'EQUITY',
    subType: 'RETAINED_EARNINGS',
    currency: 'INR',
    description: 'Accumulated retained earnings of the platform',
  },

  // ── REVENUE ───────────────────────────────────────────────────────────────
  {
    code: '4001',
    name: 'Transaction Fee Revenue',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Fees charged to customers and merchants per transaction',
  },
  {
    code: '4002',
    name: 'Interest Income – Loans',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Interest earned on personal loans disbursed',
  },
  {
    code: '4003',
    name: 'FX Conversion Revenue',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Revenue from FX spread/markup on currency conversions',
  },
  {
    code: '4010',
    name: 'Interchange Revenue',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Interchange fees earned on card-based merchant payments',
  },
  {
    code: '4020',
    name: 'Penalty Interest Revenue',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Penalty interest charged on overdue loan EMI payments',
  },
  {
    code: '4030',
    name: 'Chargeback Fee Revenue',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description: 'Fees charged to merchants on chargeback disputes',
  },

  // ── EXPENSES ──────────────────────────────────────────────────────────────
  {
    code: '5001',
    name: 'Payment Gateway Fees',
    type: 'EXPENSE',
    subType: 'OPERATING_EXPENSE',
    currency: 'INR',
    description: 'Fees paid to payment gateways for card processing',
  },
  {
    code: '5002',
    name: 'Cashback Expense',
    type: 'EXPENSE',
    subType: 'MARKETING_EXPENSE',
    currency: 'INR',
    description: 'Cashback credits awarded to customers as marketing incentive',
  },
  {
    code: '5003',
    name: 'Interest Expense – Savings',
    type: 'EXPENSE',
    subType: 'FINANCIAL_EXPENSE',
    currency: 'INR',
    description: 'Interest paid to customers on their savings wallet balances',
  },
  {
    code: '5010',
    name: 'FX Conversion Cost',
    type: 'EXPENSE',
    subType: 'OPERATING_EXPENSE',
    currency: 'INR',
    description: 'Cost basis of foreign currency purchased for conversions',
  },

  // ── SYSTEM / CONTROL ACCOUNTS ─────────────────────────────────────────────
  {
    code: '9001',
    name: 'Rounding Adjustment',
    type: 'EXPENSE',
    subType: 'OPERATING_EXPENSE',
    currency: 'INR',
    description:
      'Receives sub-unit rounding differences from FX conversions at end-of-day. ' +
      'Prevents trial balance discrepancy from accumulated decimal rounding. ' +
      'Referenced in Case Study 2 (Revolut rounding incident).',
  },
  {
    code: '9002',
    name: 'Suspense – Unreconciled',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    currency: 'INR',
    description:
      'Temporary holding for entries that cannot be immediately classified. ' +
      'Must be zero-balanced at month-end.',
  },
  {
    code: '4004',
    name: 'Unrealised FX Gain',
    type: 'REVENUE',
    subType: 'OPERATING_REVENUE',
    currency: 'INR',
    description:
      'Paper gain from revaluing foreign-currency balances at closing rate. ' +
      'Reversed and re-posted each revaluation cycle — never accumulates ' +
      'across periods (spec A3.3).',
  },
  {
    code: '5004',
    name: 'Unrealised FX Loss',
    type: 'EXPENSE',
    subType: 'FINANCIAL_EXPENSE',
    currency: 'INR',
    description: 'Paper loss from revaluing foreign-currency balances at closing rate.',
  },
  {
    code: '1043',
    name: 'FX Revaluation Suspense',
    type: 'ASSET',
    subType: 'FX_HOLDING',
    currency: 'INR',
    description:
      'Offsetting account for unrealised FX revaluation journal entries. ' +
      'Nets to zero over time as gains and losses alternate — not a real ' +
      'cash position, purely a balancing mechanism for reporting-only entries.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Seed Function
// ─────────────────────────────────────────────────────────────────────────────

export async function seedChartOfAccounts(prisma: PrismaClient): Promise<void> {
  console.log('🌱 Seeding Chart of Accounts...');

  let created = 0;
  let skipped = 0;

  for (const account of CHART_OF_ACCOUNTS) {
    const existing = await prisma.account.findUnique({
      where: { code: account.code },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.account.create({ data: account });
    created++;
    console.log(`  ✅ Created account ${account.code} — ${account.name}`);
  }

  console.log(
    `\n📊 Chart of Accounts: ${created.toString()} created, ${skipped.toString()} already existed`,
  );
  console.log(`   Total accounts: ${CHART_OF_ACCOUNTS.length.toString()}`);
}
