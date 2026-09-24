// src/transactions/handlers/payload-validation.util.ts
import { UnprocessableEntityException } from '@nestjs/common';
import { isSupportedCurrency } from '@common/types/currency.type';

/**
 * Extracts a currency code from a transaction payload and rejects it if it
 * isn't one of this system's supported currencies (Currency.type.ts).
 *
 * NOTE: none of the 20 existing handlers call this today — they each do a
 * bare `String(payload['currency'] ?? 'INR')` with no membership check,
 * a pre-existing gap this codebase carries. Retrofitting all 20 is out of
 * scope here; this helper is introduced for the new Nigeria-specific
 * handlers (nip-transfer, ussd-transfer) so they don't repeat that gap.
 */
export function requireSupportedCurrency(
  payload: Record<string, unknown>,
  key = 'currency',
): string {
  const value = String(payload[key] ?? '');
  if (!isSupportedCurrency(value)) {
    throw new UnprocessableEntityException(`Unsupported currency: ${value}`);
  }
  return value;
}
