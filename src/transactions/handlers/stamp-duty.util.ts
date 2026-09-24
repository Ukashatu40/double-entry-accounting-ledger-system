// src/transactions/handlers/stamp-duty.util.ts
import Decimal from 'decimal.js';

const STAMP_DUTY_THRESHOLD = new Decimal('10000.0000'); // ₦10,000, Finance Act
const STAMP_DUTY_FLAT_FEE = new Decimal('50.0000'); // flat ₦50

/**
 * Nigeria Finance Act stamp duty — a flat ₦50 charge on electronic
 * transfers of ₦10,000 or more. Only applies to NGN transactions; every
 * other currency returns zero. Illustrative modeling of a real Nigerian
 * fintech line item, not a compliance-certified implementation.
 */
export function computeStampDuty(amount: Decimal, currency: string): Decimal {
  if (currency !== 'NGN') return new Decimal(0);
  return amount.gte(STAMP_DUTY_THRESHOLD) ? STAMP_DUTY_FLAT_FEE : new Decimal(0);
}
