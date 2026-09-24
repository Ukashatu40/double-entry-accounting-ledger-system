// tests/integration/rate-limiting.spec.ts
//
// Regression test for the global rate limiter (ThrottlerModule, wired in
// app.module.ts) — addresses a gap the original code review flagged: no
// rate limiting was registered anywhere in the API. Uses Fastify's built-in
// `.inject()` to simulate HTTP requests against the full bootstrapped app
// without binding a real port or adding a supertest dependency.
import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { closePrisma } from './setup';

jest.setTimeout(60_000);

describe('Global rate limiting (integration)', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await closePrisma();
  });

  it('returns 429 after the configured request limit on a guarded endpoint', async () => {
    const headers = { 'x-api-key': 'dev-api-key-change-in-production' };
    let sawTooManyRequests = false;
    let firstThrottledAt = -1;

    // Deliberately malformed ID: NestJS runs Guards (ApiKeyGuard,
    // ThrottlerGuard) BEFORE Pipes, so this still exercises the throttle
    // counter on every request, but fails ParseUUIDPipe with a 400 before
    // ever reaching the controller/database. Using a real account ID here
    // previously meant every one of the 105 requests did a full DB
    // round-trip — fine locally, but on slower/shared CI hardware, 100
    // sequential DB-backed requests could take longer than the 60s
    // ThrottlerModule window, so the counter never reached the limit
    // within a single window and the test flaked in CI (never locally).
    // This version's requests are in-memory only, so timing no longer
    // depends on the DB or the environment's request latency.
    //
    // ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]) in app.module.ts
    for (let i = 1; i <= 105; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/accounts/not-a-valid-uuid',
        headers,
      });
      if (response.statusCode === 429) {
        sawTooManyRequests = true;
        firstThrottledAt = i;
        break;
      }
      expect(response.statusCode).toBe(400); // ParseUUIDPipe rejection
    }

    expect(sawTooManyRequests).toBe(true);
    expect(firstThrottledAt).toBe(101);
  });

  it('never throttles the health endpoint (@SkipThrottle)', async () => {
    for (let i = 1; i <= 105; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).not.toBe(429);
    }
  });
});
