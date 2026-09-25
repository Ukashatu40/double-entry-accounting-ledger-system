// src/common/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { Role } from '@common/types/role.type';

export const REQUIRED_ROLE_KEY = 'requiredRole';

/**
 * Marks a route as requiring at least `role` (VIEWER < OPERATOR < ADMIN —
 * see role.type.ts). Routes with no @Roles() decorator require only a
 * valid API key (any role) — the implicit minimum is VIEWER. Enforced by
 * RolesGuard, registered globally in app.module.ts.
 */
export const Roles = (role: Role): ReturnType<typeof SetMetadata> =>
  SetMetadata(REQUIRED_ROLE_KEY, role);
