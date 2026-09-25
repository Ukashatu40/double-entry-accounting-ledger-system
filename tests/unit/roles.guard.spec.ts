// tests/unit/roles.guard.spec.ts
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '@common/guards/roles.guard';
import { Role, roleMeetsMinimum } from '@common/types/role.type';
import type { ApiKeyEntry } from '@config/app.config';

function makeMockContext(headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeConfigService(entries: ApiKeyEntry[]): ConfigService {
  return {
    get: (key: string) => (key === 'app' ? { apiKeys: entries } : undefined),
  } as unknown as ConfigService;
}

function makeGuard(
  entries: ApiKeyEntry[],
  overrides: { isPublic?: boolean; requiredRole?: Role } = {},
): RolesGuard {
  const reflector = {
    getAllAndOverride: jest
      .fn()
      .mockReturnValueOnce(overrides.isPublic ?? false)
      .mockReturnValueOnce(overrides.requiredRole),
  } as unknown as Reflector;
  return new RolesGuard(reflector, makeConfigService(entries));
}

describe('roleMeetsMinimum', () => {
  it('orders VIEWER < OPERATOR < ADMIN', () => {
    expect(roleMeetsMinimum(Role.VIEWER, Role.VIEWER)).toBe(true);
    expect(roleMeetsMinimum(Role.VIEWER, Role.OPERATOR)).toBe(false);
    expect(roleMeetsMinimum(Role.OPERATOR, Role.VIEWER)).toBe(true);
    expect(roleMeetsMinimum(Role.ADMIN, Role.OPERATOR)).toBe(true);
    expect(roleMeetsMinimum(Role.OPERATOR, Role.ADMIN)).toBe(false);
    expect(roleMeetsMinimum(Role.ADMIN, Role.ADMIN)).toBe(true);
  });
});

describe('RolesGuard', () => {
  const entries: ApiKeyEntry[] = [
    { key: 'viewer-key', role: Role.VIEWER },
    { key: 'operator-key', role: Role.OPERATOR },
    { key: 'admin-key', role: Role.ADMIN },
  ];

  it('allows access to a route marked @Public() regardless of role', () => {
    const guard = makeGuard(entries, { isPublic: true, requiredRole: Role.ADMIN });
    const context = makeMockContext({});
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows any authenticated key through a route with no @Roles()', () => {
    const guard = makeGuard(entries, {});
    const context = makeMockContext({ 'x-api-key': 'viewer-key' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a VIEWER key through a route requiring VIEWER', () => {
    const guard = makeGuard(entries, { requiredRole: Role.VIEWER });
    const context = makeMockContext({ 'x-api-key': 'viewer-key' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a VIEWER key on a route requiring OPERATOR', () => {
    const guard = makeGuard(entries, { requiredRole: Role.OPERATOR });
    const context = makeMockContext({ 'x-api-key': 'viewer-key' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows an OPERATOR key through a route requiring OPERATOR', () => {
    const guard = makeGuard(entries, { requiredRole: Role.OPERATOR });
    const context = makeMockContext({ 'x-api-key': 'operator-key' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects an OPERATOR key on a route requiring ADMIN', () => {
    const guard = makeGuard(entries, { requiredRole: Role.ADMIN });
    const context = makeMockContext({ 'x-api-key': 'operator-key' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows an ADMIN key through any role requirement', () => {
    const guard = makeGuard(entries, { requiredRole: Role.ADMIN });
    const context = makeMockContext({ 'x-api-key': 'admin-key' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects an unrecognized key on a route requiring a role', () => {
    const guard = makeGuard(entries, { requiredRole: Role.VIEWER });
    const context = makeMockContext({ 'x-api-key': 'not-a-real-key' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
