// tests/unit/request-id.interceptor.spec.ts
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { RequestIdInterceptor } from '@common/interceptors/request-id.interceptor';

function makeMockContext(headers: Record<string, string> = {}) {
  const request = { headers };
  const header = jest.fn();
  const reply = { header };

  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;

  return { context, request, reply };
}

describe('RequestIdInterceptor', () => {
  let interceptor: RequestIdInterceptor;
  let next: CallHandler;

  beforeEach(() => {
    interceptor = new RequestIdInterceptor();
    next = { handle: () => of('response') };
  });

  it('generates a request ID prefixed with req_ when none is supplied', (done) => {
    const { context, request } = makeMockContext({});
    interceptor.intercept(context, next).subscribe(() => {
      expect((request as unknown as { requestId: string }).requestId).toMatch(/^req_/);
      done();
    });
  });

  it('honours a client-supplied X-Request-ID header', (done) => {
    const { context, request } = makeMockContext({ 'x-request-id': 'req_client_supplied' });
    interceptor.intercept(context, next).subscribe(() => {
      expect((request as unknown as { requestId: string }).requestId).toBe('req_client_supplied');
      done();
    });
  });

  it('sets the X-Request-ID response header', (done) => {
    const { context, reply } = makeMockContext({});
    interceptor.intercept(context, next).subscribe(() => {
      expect(reply.header).toHaveBeenCalledWith('X-Request-ID', expect.stringMatching(/^req_/));
      done();
    });
  });

  it('passes through the original observable value unchanged', (done) => {
    const { context } = makeMockContext({});
    interceptor.intercept(context, next).subscribe((value) => {
      expect(value).toBe('response');
      done();
    });
  });
});
