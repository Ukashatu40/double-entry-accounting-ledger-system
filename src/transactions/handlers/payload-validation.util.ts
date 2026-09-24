// src/transactions/handlers/payload-validation.util.ts
import { UnprocessableEntityException } from '@nestjs/common';
import { isSupportedCurrency } from '@common/types/currency.type';

/**
 * Extracts a currency code from a transaction payload and rejects it if it
 * isn't one of this system's supported currencies (Currency.type.ts).
 *
 * Falls back to `defaultValue` (INR, matching every handler's own
 * pre-existing `String(payload['currency'] ?? 'INR')` convention) when the
 * field is entirely absent — this deliberately mirrors that established
 * default rather than requiring every caller to now pass one explicitly,
 * which would have been a breaking behavior change. The actual gap this
 * closes is different: previously a *present but garbage* currency string
 * (e.g. "ZZZ") silently passed through with no membership check at all;
 * that case is now rejected regardless of the default.
 */
export function requireSupportedCurrency(
  payload: Record<string, unknown>,
  key = 'currency',
  defaultValue = 'INR',
): string {
  const value = String(payload[key] ?? defaultValue);
  if (!isSupportedCurrency(value)) {
    throw new UnprocessableEntityException(`Unsupported currency: ${value}`);
  }
  return value;
}
