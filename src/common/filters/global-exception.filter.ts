// src/common/filters/global-exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { uuidv7 } from 'uuidv7';

/**
 * Structured error response format.
 * Every error from this API follows this exact shape — no exceptions.
 * Matches the format specified in Part A10.2 of the spec.
 */
interface ErrorResponse {
  error: {
    type: string;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
    timestamp: string;
  };
}

/**
 * Maps well-known error types to structured error codes.
 * These codes appear in API responses and can be handled programmatically
 * by clients without parsing human-readable messages.
 */
function resolveErrorCode(exception: unknown): { type: string; code: string } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return { type: 'VALIDATION_ERROR', code: 'REQ_4000' };
      case HttpStatus.UNAUTHORIZED:
        return { type: 'AUTHENTICATION_ERROR', code: 'REQ_4001' };
      case HttpStatus.FORBIDDEN:
        return { type: 'AUTHORISATION_ERROR', code: 'REQ_4003' };
      case HttpStatus.NOT_FOUND:
        return { type: 'NOT_FOUND', code: 'REQ_4004' };
      case HttpStatus.CONFLICT:
        return { type: 'CONFLICT', code: 'REQ_4009' };
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return { type: 'BUSINESS_RULE_VIOLATION', code: 'TXN_4220' };
      case HttpStatus.TOO_MANY_REQUESTS:
        return { type: 'RATE_LIMIT_EXCEEDED', code: 'REQ_4029' };
      default:
        return { type: 'INTERNAL_ERROR', code: 'SYS_5000' };
    }
  }

  // Ledger-specific domain errors
  if (exception instanceof Error) {
    const msg = exception.message.toLowerCase();
    if (msg.includes('insufficient balance'))
      return { type: 'INSUFFICIENT_BALANCE', code: 'TXN_4001' };
    if (msg.includes('unbalanced journal'))
      return { type: 'UNBALANCED_JOURNAL_ENTRY', code: 'TXN_4002' };
    if (msg.includes('idempotency')) return { type: 'IDEMPOTENCY_CONFLICT', code: 'TXN_4003' };
    if (msg.includes('is stale') || msg.includes('expired rate'))
      return { type: 'STALE_EXCHANGE_RATE', code: 'FX_4001' };
    if (msg.includes('hash chain')) return { type: 'AUDIT_CHAIN_VIOLATION', code: 'AUD_5001' };
    if (msg.includes('already reversed')) return { type: 'ALREADY_REVERSED', code: 'TXN_4004' };
    if (msg.includes('refund exceeds'))
      return { type: 'REFUND_EXCEEDS_ORIGINAL', code: 'TXN_4005' };
    // Transient DB-level contention that survived withRetryTransaction's
    // built-in retries (database.service.ts) — this is infrastructure
    // load, not an application bug or a business rule violation. Per spec
    // A10.1/A10.4, this belongs in the 503/retryable category, not a bare
    // unclassified 500 — the client should back off and retry with a new
    // idempotency key attempt, not treat it as a permanent failure.
    if (
      msg.includes('transactionwriteconflict') ||
      msg.includes('deadlock detected') ||
      msg.includes('could not serialize')
    ) {
      return { type: 'TRANSACTION_CONFLICT', code: 'SYS_5003' };
    }
  }

  return { type: 'INTERNAL_ERROR', code: 'SYS_5000' };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const requestId = (request.headers['x-request-id'] as string | undefined) ?? `req_${uuidv7()}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'An unexpected error occurred';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        message = response;
      } else if (typeof response === 'object' && response !== null) {
        const r = response as Record<string, unknown>;
        // NestJS validation pipe returns { message: string[] }
        if (Array.isArray(r['message'])) {
          message = 'Request validation failed';
          details = { validation_errors: r['message'] };
        } else {
          message = (r['message'] as string | undefined) ?? message;
          details = r['details'] as Record<string, unknown> | undefined;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      // Never expose stack traces to the client
      if (process.env['NODE_ENV'] === 'development') {
        details = { stack: exception.stack };
      }
    }

    const { type, code } = resolveErrorCode(exception);

    // Transient conflicts get reclassified to 503 + Retry-After, per spec
    // A10.4's graceful-degradation guidance — these are retry-worthy, not
    // permanent failures, and a bare 500 doesn't communicate that to callers.
    if (type === 'TRANSACTION_CONFLICT') {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      void reply.header('Retry-After', '1');
    }

    // Log internal errors with full context
    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${status.toString()} ${type}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${requestId}] ${status.toString()} ${type}: ${message}`);
    }

    const body: ErrorResponse = {
      error: {
        type,
        code,
        message,
        ...(details !== undefined && { details }),
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    };

    void reply.status(status).send(body);
  }
}
