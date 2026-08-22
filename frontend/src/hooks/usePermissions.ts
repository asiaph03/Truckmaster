import { useMemo } from 'react';
import {
  FULL_FINANCIAL_VISIBILITY_ROLES,
  NAV_VISIBILITY,
  ROLE_PERMISSIONS,
  roleHasPermission,
  type NavItem,
  type PermissionKey,
} from '@tms/shared-constants';
import { useSessionStore } from '../auth/session-store';

/**
 * UX-only. Every check here has a corresponding server-side enforcement
 * already shipped (Guards + shapeFinancialFields) — this hook only
 * prevents rendering dead-end UI; it never gates data. A wrong or
 * missing check here fails safe as a server-side 403/redaction, not as
 * a leak (§10 of the approved Phase 1 plan).
 */
export function usePermissions() {
  const roles = useSessionStore((s) => s.roles);

  return useMemo(() => {
    const can = (permission: PermissionKey) => roleHasPermission(roles, permission);

    const canSeeNav = (item: NavItem) => roles.some((role) => NAV_VISIBILITY[role]?.[item]);

    const isFullVisibility = () =>
      roles.some((role) => FULL_FINANCIAL_VISIBILITY_ROLES.includes(role));

    return { roles, can, canSeeNav, isFullVisibility, ROLE_PERMISSIONS };
  }, [roles]);
}
