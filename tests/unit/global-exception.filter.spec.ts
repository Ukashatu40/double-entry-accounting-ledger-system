// tests/unit/global-exception.filter.spec.ts
import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { GlobalExceptionFilter } from '@common/filters/global-exception.filter';

function makeMockHost(headers: Record<string, string> = {}): {
  host: ArgumentsHost;
  reply: { status: jest.Mock; send: jest.Mock };
} {
  const send = jest.fn();
  const status = jest.fn().mockReturnValue({ send });
  const reply = { status, send };

  const request = { headers };

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, reply: { status, send } };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  it('maps an HttpException with BAD_REQUEST status to VALIDATION_ERROR type', () => {
    const { host, reply } = makeMockHost();
    const exception = new HttpException('Invalid input', HttpStatus.BAD_REQUEST);

    filter.catch(exception, host);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('VALIDATION_ERROR');
    expect(body.error.code).toBe('REQ_4000');
  });

  it('maps UNAUTHORIZED to AUTHENTICATION_ERROR', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new HttpException('No key', HttpStatus.UNAUTHORIZED), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('AUTHENTICATION_ERROR');
  });

  it('maps UNPROCESSABLE_ENTITY to BUSINESS_RULE_VIOLATION', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new HttpException('Bad state', HttpStatus.UNPROCESSABLE_ENTITY), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.error.code).toBe('TXN_4220');
  });

  it('detects INSUFFICIENT_BALANCE from a plain Error message', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('Insufficient balance on account xyz'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('INSUFFICIENT_BALANCE');
    expect(body.error.code).toBe('TXN_4001');
  });

  it('detects UNBALANCED_JOURNAL_ENTRY from a plain Error message', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('Unbalanced journal entry: debits=100 credits=90'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('UNBALANCED_JOURNAL_ENTRY');
  });

  it('detects STALE_EXCHANGE_RATE from a stale rate error message', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('Exchange rate is stale: captured 90 minutes ago'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('STALE_EXCHANGE_RATE');
  });

  it('falls back to INTERNAL_ERROR for an unrecognised plain Error', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('Something totally unexpected happened'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.type).toBe('INTERNAL_ERROR');
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('includes a request_id in every error response, honouring X-Request-ID header', () => {
    const { host, reply } = makeMockHost({ 'x-request-id': 'req_custom_123' });
    filter.catch(new Error('any error'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.request_id).toBe('req_custom_123');
  });

  it('generates a request_id when none is supplied', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('any error'), host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.request_id).toMatch(/^req_/);
  });

  it('includes an ISO timestamp on every error response', () => {
    const { host, reply } = makeMockHost();
    filter.catch(new Error('any error'), host);
    const body = reply.send.mock.calls[0][0];
    expect(() => new Date(body.error.timestamp).toISOString()).not.toThrow();
  });

  it('extracts array-form validation messages from NestJS ValidationPipe exceptions', () => {
    const { host, reply } = makeMockHost();
    const exception = new HttpException(
      { message: ['amount must be a positive number', 'currency must be 3 characters'] },
      HttpStatus.BAD_REQUEST,
    );
    filter.catch(exception, host);
    const body = reply.send.mock.calls[0][0];
    expect(body.error.message).toBe('Request validation failed');
    expect(body.error.details.validation_errors).toHaveLength(2);
  });
});
