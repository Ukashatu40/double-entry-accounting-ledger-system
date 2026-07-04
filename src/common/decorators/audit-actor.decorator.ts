// src/common/decorators/audit-actor.decorator.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Extracted as a standalone exported function so it can be unit tested
 * directly without needing to reach into NestJS's internal decorator
 * metadata. The decorator itself is now a thin wrapper.
 */
export function resolveActorFromHeaders(headers: Record<string, unknown>): string {
  const userId = headers['x-user-id'];
  if (typeof userId === 'string' && userId.trim().length > 0) {
    return userId.trim();
  }

  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string') {
    return `service:${apiKey.slice(0, 8)}`;
  }

  return 'SYSTEM';
}

export const AuditActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  return resolveActorFromHeaders(request.headers as Record<string, unknown>);
});
