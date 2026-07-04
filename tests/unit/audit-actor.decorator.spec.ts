// tests/unit/audit-actor.decorator.spec.ts
import { resolveActorFromHeaders } from '@common/decorators/audit-actor.decorator';

describe('resolveActorFromHeaders', () => {
  it('returns the trimmed X-User-ID header when present', () => {
    expect(resolveActorFromHeaders({ 'x-user-id': '  user_123  ' })).toBe('user_123');
  });

  it('falls back to a service identity derived from X-API-Key when no user ID is present', () => {
    expect(resolveActorFromHeaders({ 'x-api-key': 'sk_live_1234567890abcdef' })).toBe(
      'service:sk_live_',
    );
  });

  it('falls back to SYSTEM when neither header is present', () => {
    expect(resolveActorFromHeaders({})).toBe('SYSTEM');
  });

  it('falls back to SYSTEM when X-User-ID is an empty/whitespace string', () => {
    expect(resolveActorFromHeaders({ 'x-user-id': '   ' })).toBe('SYSTEM');
  });

  it('prefers X-User-ID over X-API-Key when both are present', () => {
    expect(resolveActorFromHeaders({ 'x-user-id': 'user_456', 'x-api-key': 'sk_test_abc' })).toBe(
      'user_456',
    );
  });
});
