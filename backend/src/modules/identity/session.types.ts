import 'express-session';
import { MembershipRoleName } from '@prisma/client';

/**
 * Redis-backed session payload (TECHNICAL_ARCHITECTURE.md §3.2).
 * organizationId/membershipId/roles are absent until the user has an
 * active membership selected — see AuthService.login's three cases
 * (auto-select / org-pending / no-workspace).
 */
export interface SessionData {
  userId: string;
  organizationId?: string;
  membershipId?: string;
  roles?: MembershipRoleName[];
}

declare module 'express-session' {
  interface SessionData {
    auth?: import('./session.types').SessionData;
  }
}
