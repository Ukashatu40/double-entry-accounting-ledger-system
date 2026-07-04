// tests/unit/idempotency.decorator.spec.ts
import { resolveIdempotencyKey } from '@common/decorators/idempotency.decorator';

describe('resolveIdempotencyKey', () => {
  it('returns the trimmed key when the header is present', () => {
    expect(resolveIdempotencyKey({ 'x-idempotency-key': '  abc-123  ' })).toBe('abc-123');
  });

  it('returns undefined when the header is missing', () => {
    expect(resolveIdempotencyKey({})).toBeUndefined();
  });

  it('returns undefined when the header value is not a string', () => {
    expect(
      resolveIdempotencyKey({ 'x-idempotency-key': 12345 as unknown as string }),
    ).toBeUndefined();
  });
});
