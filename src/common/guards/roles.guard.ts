// src/common/guards/roles.guard.ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '@config/app.config';
import { Role, roleMeetsMinimum } from '@common/types/role.type';
import { IS_PUBLIC_KEY, buildApiKeyRoleMap } from '@common/guards/api-key.guard';
import { REQUIRED_ROLE_KEY } from '@common/decorators/roles.decorator';

/**
 * Role-tier enforcement — runs after ApiKeyGuard (registered second in
 * app.module.ts's APP_GUARD list) and can therefore assume the X-API-Key
 * header is already known-valid; it only re-resolves which role that key
 * maps to and checks it against the route's @Roles() requirement, if any.
 *
 * Re-resolving independently (rather than having ApiKeyGuard stash the
 * role on the request) keeps each guard self-contained and avoids
 * depending on Fastify request-object mutation/typing for something this
 * cheap (a single Map lookup).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly roleByKey: Map<string, Role>;

  constructor(
    private readonly reflector: Reflector,
    configService: ConfigService,
  ) {
    const appConfig = configService.get<AppConfig>('app');
    if (!appConfig) throw new Error('App configuration missing');
    this.roleByKey = buildApiKeyRoleMap(appConfig.apiKeys);
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRole = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Roles() on this route — any authenticated key (already verified
    // valid by ApiKeyGuard) passes.
    if (!requiredRole) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const apiKey = request.headers['x-api-key'];
    const actualRole = typeof apiKey === 'string' ? this.roleByKey.get(apiKey) : undefined;

    if (!actualRole || !roleMeetsMinimum(actualRole, requiredRole)) {
      throw new ForbiddenException(
        `This action requires the ${requiredRole} role or higher` +
          (actualRole ? ` — your key is ${actualRole}` : ''),
      );
    }

    return true;
  }
}
