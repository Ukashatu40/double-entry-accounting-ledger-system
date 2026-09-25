// src/auth/auth.controller.ts
import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '@config/app.config';
import { buildApiKeyRoleMap } from '@common/guards/api-key.guard';
import type { Role } from '@common/types/role.type';

interface WhoAmIResponse {
  role: Role;
}

/**
 * Lets a caller (chiefly the frontend, right after it's configured with a
 * key) ask "what can I actually do?" instead of discovering its role by
 * trial and error against 403s. Protected by the same global ApiKeyGuard
 * as everything else — no @Roles() needed, since any valid key can see
 * its own role.
 */
@ApiTags('auth')
@ApiSecurity('api-key')
@Controller('auth')
export class AuthController {
  private readonly roleByKey: Map<string, Role>;

  constructor(configService: ConfigService) {
    const appConfig = configService.get<AppConfig>('app');
    if (!appConfig) throw new Error('App configuration missing');
    this.roleByKey = buildApiKeyRoleMap(appConfig.apiKeys);
  }

  @Get('whoami')
  @ApiOperation({ summary: "The current API key's resolved role (VIEWER/OPERATOR/ADMIN)" })
  @ApiOkResponse({ description: 'Resolved role for the caller’s X-API-Key' })
  whoami(@Req() request: FastifyRequest): WhoAmIResponse {
    const apiKey = request.headers['x-api-key'];
    // ApiKeyGuard has already rejected an invalid/missing key by the time
    // this handler runs, so a lookup miss here should be unreachable —
    // but the type of `role` still has to come from somewhere real.
    const role = typeof apiKey === 'string' ? this.roleByKey.get(apiKey) : undefined;
    return { role: role as Role };
  }
}
