// scripts/run-fx-revaluation.ts
// Usage: npm run fx:revalue -- --suspense-account <uuid>
// Intended to be invoked by a cron job / scheduled task nightly.
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { FxRevaluationService } from '../src/fx/fx-revaluation.service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const suspenseIdx = args.indexOf('--suspense-account');
  let suspenseAccountId = suspenseIdx >= 0 ? args[suspenseIdx + 1] : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  if (!suspenseAccountId) {
    // Auto-resolve the seeded suspense account by code if not passed explicitly
    const prisma = new PrismaClient();
    const account = await prisma.account.findUnique({ where: { code: '1043' } });
    await prisma.$disconnect();
    if (!account) {
      console.error('❌ No --suspense-account provided and account 1043 not found in seed data');
      process.exit(1);
    }
    suspenseAccountId = account.id;
  }

  const revaluationService = app.get(FxRevaluationService);
  const result = await revaluationService.runRevaluation(new Date(), suspenseAccountId);

  console.log('\n📊 FX Revaluation Run Complete');
  console.log(`   Run ID: ${result.runId}`);
  console.log(`   Positions revalued: ${result.lines.length.toString()}`);
  console.log(`   Total unrealised gain: INR ${result.totalUnrealisedGain}`);
  console.log(`   Total unrealised loss: INR ${result.totalUnrealisedLoss}`);
  console.log(`   Net impact: INR ${result.netUnrealisedImpact}`);
  console.log(`   Journal posted: ${result.journalId ?? '(none — no change)'}\n`);

  await app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('❌ FX revaluation run failed:', err);
  process.exit(1);
});
