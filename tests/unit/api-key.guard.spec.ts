// tests/unit/api-key.guard.spec.ts
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, IS_PUBLIC_KEY } from '@common/guards/api-key.guard';

function makeMockContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeConfigService(keys: string[]): ConfigService {
  return {
    get: (key: string) => (key === 'app' ? { apiKeys: keys } : undefined),
  } as unknown as ConfigService;
}

describe('ApiKeyGuard', () => {
  const VALID_KEY = 'test-valid-key-123';

  function makeGuard(isPublic: boolean): ApiKeyGuard {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(isPublic),
    } as unknown as Reflector;
    return new ApiKeyGuard(reflector, makeConfigService([VALID_KEY]));
  }

  it('allows access to a route marked @Public() with no API key', () => {
    const guard = makeGuard(true);
    const context = makeMockContext({});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows access when a valid X-API-Key header is present', () => {
    const guard = makeGuard(false);
    const context = makeMockContext({ 'x-api-key': VALID_KEY });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('throws UnauthorizedException when X-API-Key header is missing', () => {
    const guard = makeGuard(false);
    const context = makeMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when X-API-Key does not match any configured key', () => {
    const guard = makeGuard(false);
    const context = makeMockContext({ 'x-api-key': 'wrong-key' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('throws if the app configuration is missing entirely', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const emptyConfig = { get: () => undefined } as unknown as ConfigService;
    expect(() => new ApiKeyGuard(reflector, emptyConfig)).toThrow('App configuration missing');
  });

  it('accepts any one of multiple configured API keys', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new ApiKeyGuard(
      reflector,
      makeConfigService(['key-one', 'key-two', 'key-three']),
    );
    const context = makeMockContext({ 'x-api-key': 'key-two' });
    expect(guard.canActivate(context)).toBe(true);
  });
});
