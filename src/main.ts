// src/main.ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false, // Pino handles logging — disable Fastify's built-in
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  // ── Pino structured logger ───────────────────
  app.useLogger(app.get(Logger));

  // ── Global API prefix ────────────────────────
  const apiPrefix = process.env.API_PREFIX ?? 'api/v1';
  app.setGlobalPrefix(apiPrefix);

  // ── Global validation pipe ───────────────────
  // whitelist: strip unknown properties (security)
  // forbidNonWhitelisted: reject requests with unknown properties
  // transform: auto-transform payloads to DTO class instances
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false, // explicit is safer for financial data
      },
    }),
  );

  // ── Swagger / OpenAPI ────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('NovaPay Ledger System')
      .setDescription('Double-Entry Accounting Ledger with Immutable Audit Trail')
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
      .addTag('accounts', 'Chart of Accounts management')
      .addTag('transactions', 'Transaction processing engine')
      .addTag('ledger', 'Ledger entries and balance queries')
      .addTag('fx', 'Foreign exchange rate management')
      .addTag('reversals', 'Reversal and refund engine')
      .addTag('audit', 'Audit trail and hash chain verification')
      .addTag('reporting', 'Financial reports and statements')
      .addTag('health', 'System health and readiness checks')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
      },
    });
  }

  // ── CORS (development only) ──────────────────
  if (process.env.NODE_ENV === 'development') {
    app.enableCors({ origin: '*' });
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`🚀 Ledger API running on port ${port.toString()}`);
  logger.log(`📖 Swagger docs: http://localhost:${port.toString()}/${apiPrefix}/docs`);
}

void bootstrap();
