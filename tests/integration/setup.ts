// tests/integration/setup.ts
import * as path from 'path';
import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
// Explicitly use TEST_DATABASE_URL — set by jest.setup.ts before tests run

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// 2. Select the isolated integration test database URL, with a safe fallback string
const rawUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const cleanDbUrl = rawUrl.replace(/(^["']|["']$)/g, '').trim();

if (!cleanDbUrl) {
  console.error('❌ Integration Setup Error: No database URL found in environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: cleanDbUrl,
  max: 5, // Keep the connection pool small for integration tests
});
const adapter = new PrismaPg(pool);

// 4. Instantiate Prisma using the driver adapter configuration
const prisma = new PrismaClient({ adapter });

/**
 * Wipe all transactional data between tests.
 * Uses TRUNCATE CASCADE for speed and to handle FK constraints in one shot.
 * Reference data (accounts, exchange_rate_snapshots) is preserved.
 */
export async function cleanDatabase(): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          balance_snapshots,
          idempotency_keys,
          reversals,
          audit_events,
          ledger_entries,
          transactions
        RESTART IDENTITY CASCADE
      `);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('deadlock') && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        continue;
      }
      throw error;
    }
  }
}

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}

export { prisma };
