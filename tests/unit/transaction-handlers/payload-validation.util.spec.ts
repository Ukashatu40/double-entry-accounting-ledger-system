// tests/unit/transaction-handlers/payload-validation.util.spec.ts
import { requireSupportedCurrency } from '@transactions/handlers/payload-validation.util';

describe('requireSupportedCurrency', () => {
  it('returns the currency when it is present and supported', () => {
    expect(requireSupportedCurrency({ currency: 'NGN' })).toBe('NGN');
    expect(requireSupportedCurrency({ currency: 'USD' })).toBe('USD');
  });

  it('defaults to INR when the field is entirely absent (matches every handler\'s pre-existing convention)', () => {
    expect(requireSupportedCurrency({})).toBe('INR');
  });

  it('honors a caller-supplied default for a differently-named field (e.g. fx-conversion.sourceCurrency)', () => {
    expect(requireSupportedCurrency({}, 'sourceCurrency', 'USD')).toBe('USD');
  });

  it('rejects a currency that is present but not in the supported list (the actual gap this closes)', () => {
    expect(() => requireSupportedCurrency({ currency: 'ZZZ' })).toThrow('Unsupported currency: ZZZ');
  });

  it('rejects an empty string explicitly supplied', () => {
    expect(() => requireSupportedCurrency({ currency: '' })).toThrow('Unsupported currency');
  });

  it('reads a custom key', () => {
    expect(requireSupportedCurrency({ targetCurrency: 'GBP' }, 'targetCurrency')).toBe('GBP');
    expect(() => requireSupportedCurrency({ targetCurrency: 'XYZ' }, 'targetCurrency')).toThrow(
      'Unsupported currency: XYZ',
    );
  });
});
