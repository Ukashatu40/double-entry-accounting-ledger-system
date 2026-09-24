// src/transactions/handlers/nigeria-levies.util.ts
import Decimal from 'decimal.js';

const VAT_RATE = new Decimal('0.075'); // Nigeria's standard VAT rate, 7.5%
const CYBERSECURITY_LEVY_RATE = new Decimal('0.00005'); // 0.005%, per the Cybercrime Act as amended

/**
 * VAT at Nigeria's standard 7.5% rate, applied to the transaction FEE (not
 * the principal amount) — analogous to how account 2020 (Tax Collected at
 * Source) is applied to the India-side fee/remittance flows. Only applies
 * to NGN transactions; every other currency returns zero.
 */
export function computeVat(fee: Decimal, currency: string): Decimal {
  if (currency !== 'NGN') return new Decimal(0);
  return fee.times(VAT_RATE).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * CBN Cybersecurity Levy — 0.005% of the transaction AMOUNT (not the fee),
 * per the Cybercrime (Prohibition, Prevention, etc.) Act as amended,
 * remitted to the National Cybersecurity Fund via CBN. Only applies to NGN
 * transactions; every other currency returns zero. Illustrative modeling,
 * not a compliance-certified rate feed.
 */
export function computeCybersecurityLevy(amount: Decimal, currency: string): Decimal {
  if (currency !== 'NGN') return new Decimal(0);
  return amount.times(CYBERSECURITY_LEVY_RATE).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}
