// src/common/guards/api-key.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig, ApiKeyEntry } from '@config/app.config';
import type { Role } from '@common/types/role.type';

/**
 * Decorator to mark a route as publicly accessible (no API key required).
 * Used on the health endpoint and Swagger UI.
 */
export const IS_PUBLIC_KEY = 'isPublic';
import { SetMetadata } from '@nestjs/common';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

/** Shared by ApiKeyGuard and RolesGuard — both need the same key→role lookup. */
export function buildApiKeyRoleMap(entries: ApiKeyEntry[]): Map<string, Role> {
  return new Map(entries.map((entry) => [entry.key, entry.role]));
}

/**
 * API Key guard — validates X-API-Key header against configured keys.
 *
 * Applied globally in app.module.ts so every route is protected by default.
 * Routes that should be public (health check, Swagger) are marked with @Public().
 * Role-tier enforcement (VIEWER/OPERATOR/ADMIN) is a separate concern —
 * see RolesGuard, which runs after this one and assumes the key is
 * already known-valid by the time it executes.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
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
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const apiKey = request.headers['x-api-key'];

    if (typeof apiKey !== 'string' || !this.roleByKey.has(apiKey)) {
      throw new UnauthorizedException('Missing or invalid X-API-Key header');
    }

    return true;
  }
}
