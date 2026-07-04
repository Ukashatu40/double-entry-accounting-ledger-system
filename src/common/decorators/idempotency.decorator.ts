// src/common/decorators/idempotency.decorator.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export function resolveIdempotencyKey(headers: Record<string, unknown>): string | undefined {
  const key = headers['x-idempotency-key'];
  return typeof key === 'string' ? key.trim() : undefined;
}

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return resolveIdempotencyKey(request.headers as Record<string, unknown>);
  },
);
