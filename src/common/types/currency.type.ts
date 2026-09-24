// src/common/types/currency.type.ts

/**
 * Supported ISO 4217 currency codes.
 * Extend this enum as new currencies are onboarded.
 */
export enum Currency {
  INR = 'INR',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  JPY = 'JPY',
  AED = 'AED',
  SGD = 'SGD',
  NGN = 'NGN',
}

/** All supported currency codes as a tuple — used for class-validator @IsIn() */
export const SUPPORTED_CURRENCIES = Object.values(Currency) as [string, ...string[]];

/**
 * Returns true if the given string is a supported ISO 4217 currency code.
 */
export function isSupportedCurrency(value: string): value is Currency {
  return SUPPORTED_CURRENCIES.includes(value);
}

/**
 * Number of decimal places for each currency.
 * JPY has 0 decimal places; most others have 2.
 * We store everything as NUMERIC(19,4) internally but apply
 * display rounding per currency when formatting for API responses.
 */
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  [Currency.INR]: 2,
  [Currency.USD]: 2,
  [Currency.EUR]: 2,
  [Currency.GBP]: 2,
  [Currency.JPY]: 0,
  [Currency.AED]: 2,
  [Currency.SGD]: 2,
  [Currency.NGN]: 2,
};
