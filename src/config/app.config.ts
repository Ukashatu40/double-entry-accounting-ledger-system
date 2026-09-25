// src/config/app.config.ts
import { registerAs } from '@nestjs/config';
import { Role, isRole } from '@common/types/role.type';

export interface ApiKeyEntry {
  key: string;
  role: Role;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  apiKeys: ApiKeyEntry[];
  genesisHash: string;
  idempotencyTtlHours: number;
  fxRateMaxAgeMinutes: number;
  logLevel: string;
  logPretty: boolean;
  metricsEnabled: boolean;
}

/**
 * API_KEYS format: comma-separated `key` or `key:ROLE` entries, e.g.
 *   API_KEYS=admin-key:ADMIN,ops-key:OPERATOR,view-key:VIEWER
 * A bare key with no `:ROLE` suffix defaults to ADMIN — this keeps the
 * original single-key setup (API_KEYS=some-key, full access, no tiers)
 * working unchanged; scoping a key down to OPERATOR/VIEWER is opt-in.
 */
function parseApiKeys(raw: string): ApiKeyEntry[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, roleRaw] = entry.split(':').map((part) => part.trim());
      if (roleRaw) {
        if (!isRole(roleRaw)) {
          throw new Error(
            `API_KEYS: invalid role "${roleRaw}" for key "${key}" — must be one of VIEWER, OPERATOR, ADMIN`,
          );
        }
        return { key, role: roleRaw };
      }
      return { key, role: Role.ADMIN };
    });
}

export default registerAs('app', (): AppConfig => {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const idempotencyTtlHours = parseInt(process.env.IDEMPOTENCY_TTL_HOURS ?? '24', 10);
  const fxRateMaxAgeMinutes = parseInt(process.env.FX_RATE_MAX_AGE_MINUTES ?? '60', 10);

  const apiKeys = parseApiKeys(process.env.API_KEYS ?? '');

  if (apiKeys.length === 0) {
    throw new Error('API_KEYS environment variable must contain at least one key');
  }

  const genesisHash =
    process.env.GENESIS_HASH ?? '0000000000000000000000000000000000000000000000000000000000000000';

  if (genesisHash.length !== 64) {
    throw new Error('GENESIS_HASH must be exactly 64 hex characters (SHA-256 zero hash)');
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port,
    apiPrefix: process.env.API_PREFIX ?? 'api/v1',
    apiKeys,
    genesisHash,
    idempotencyTtlHours,
    fxRateMaxAgeMinutes,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    logPretty: process.env.LOG_PRETTY === 'true',
    metricsEnabled: process.env.METRICS_ENABLED !== 'false',
  };
});
