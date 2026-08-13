import { SetMetadata } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';

/**
 * Coarse, Guard-level role check (TECHNICAL_ARCHITECTURE.md §2.5) — "does
 * this role ever have permission to call this endpoint at all," driven by
 * the §7 Permissions Matrix. Fine-grained checks that need loaded entity
 * data (self-review prevention, ownership, zero-Admin protection) remain
 * in the service layer (MembershipService), not here.
 */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: MembershipRoleName[]) => SetMetadata(ROLES_KEY, roles);
