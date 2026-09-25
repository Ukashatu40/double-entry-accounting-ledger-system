// src/common/types/role.type.ts
/**
 * The backend's permission tiers. There is still no per-user identity —
 * this is role-tiered API keys, not user accounts — but it is a real,
 * backend-enforced boundary, not a cosmetic frontend toggle. Each
 * configured API key resolves to exactly one of these (see
 * app.config.ts's API_KEYS parsing).
 *
 * VIEWER   — every GET endpoint (read-only).
 * OPERATOR — VIEWER + the routine day-to-day writes: submitting
 *            transactions, creating accounts, ingesting FX rates,
 *            processing reversals.
 * ADMIN    — OPERATOR + higher-blast-radius actions: deactivating
 *            accounts, raw journal-entry posting (bypasses the
 *            transaction-type business-rule validation the normal
 *            /transactions endpoint enforces), FX revaluation runs, and
 *            the full regulator audit export.
 */
export enum Role {
  VIEWER = 'VIEWER',
  OPERATOR = 'OPERATOR',
  ADMIN = 'ADMIN',
}

const ROLE_ORDER: readonly Role[] = [Role.VIEWER, Role.OPERATOR, Role.ADMIN];

/** True if `actual` is at least as privileged as `required` in the tier order above. */
export function roleMeetsMinimum(actual: Role, required: Role): boolean {
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(required);
}

export function isRole(value: string): value is Role {
  return (ROLE_ORDER as string[]).includes(value);
}
