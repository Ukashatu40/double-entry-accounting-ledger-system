// seeds/seed.ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv'; // 1. Import dotenv
import { seedChartOfAccounts } from './chart-of-accounts.seed';
import { seedExchangeRates } from './exchange-rates.seed';
import { seedTransactionLimits } from './transaction-limits.seed';

dotenv.config();

// 1. Establish a standard PostgreSQL connection pool using your local URL
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

// 2. Pass the adapter directly into the Prisma Client constructor
const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
});

async function main(): Promise<void> {
  console.log('🚀 Starting database seed...\n');

  // Seeds run in dependency order
  await seedChartOfAccounts(prisma);

  await seedExchangeRates(prisma);

  await seedTransactionLimits(prisma);

  console.log('\n✅ Seed complete.\n');
}

main()
  .catch((error: unknown) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end(); // Clean up the raw connection pool on finish
  });
