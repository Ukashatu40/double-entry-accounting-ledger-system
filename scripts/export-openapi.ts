// scripts/export-openapi.ts
// Usage: npm run docs:openapi
// Boots the NestJS app just long enough to generate the OpenAPI document,
// writes it to docs/api/openapi.yaml, then exits without starting a listener.
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as yaml from 'js-yaml';
import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  console.log('📖 Generating OpenAPI specification...\n');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: ['error'] }, // suppress startup noise — we only need the doc
  );

  const config = new DocumentBuilder()
    .setTitle('NovaPay Ledger System')
    .setDescription(
      'Double-Entry Accounting Ledger with Immutable Audit Trail — Zetheta BED-6C\n\n' +
        'Assessment: Ledger System with Double-Entry Accounting & Immutable Audit Trail\n' +
        'Intern ID: 493556B',
    )
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .addTag('accounts', 'Chart of Accounts management')
    .addTag('transactions', 'Transaction processing engine — all 20 types')
    .addTag('ledger', 'Ledger entries and balance queries')
    .addTag('fx', 'Foreign exchange rate management')
    .addTag('reversals', 'Reversal and refund engine')
    .addTag('audit', 'Audit trail and hash chain verification')
    .addTag('reporting', 'Financial reports and statements')
    .addTag('health', 'System health and readiness checks')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outputPath = 'docs/api/openapi.yaml';
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, yaml.dump(document, { noRefs: true, lineWidth: 120 }));

  console.log(`✅ OpenAPI spec written to ${outputPath}`);
  console.log(`   Endpoints documented: ${Object.keys(document.paths).length.toString()}`);

  await app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('❌ Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
