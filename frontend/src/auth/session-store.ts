import { create } from 'zustand';
import type { MembershipRoleName } from '@tms/shared-constants';
import { authApi, type OrganizationSummary, isAuthenticationError } from '../api';
import { setUnauthorizedHandler } from '../api/client';
import { queryClient } from '../api/queryClient';

export type SessionStatus =
  'loading' | 'unauthenticated' | 'organization-selection-required' | 'authenticated';

export interface AppliedSession {
  userId: string;
  organizationId?: string;
  roles?: MembershipRoleName[];
}

interface SessionState {
  status: SessionStatus;
  userId?: string;
  organizationId?: string;
  roles: MembershipRoleName[];
  /** Populated only while status === 'organization-selection-required'. */
  pendingOrganizations: OrganizationSummary[];

  /**
   * The single code path from "no session" / "wrong org" to
   * "authenticated in org X" — used identically by first login and by
   * a mid-session switchOrganization (§8 of the approved plan), so the
   * two can't silently diverge in behavior.
   */
  applySession: (session: AppliedSession) => void;
  requireOrganizationSelection: (organizations: OrganizationSummary[]) => void;
  clear: () => void;
  bootstrap: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'loading',
  roles: [],
  pendingOrganizations: [],

  applySession: (session) => {
    set({
      status: 'authenticated',
      userId: session.userId,
      organizationId: session.organizationId,
      roles: session.roles ?? [],
      pendingOrganizations: [],
    });
  },

  requireOrganizationSelection: (organizations) => {
    set({ status: 'organization-selection-required', pendingOrganizations: organizations });
  },

  clear: () => {
    set({
      status: 'unauthenticated',
      userId: undefined,
      organizationId: undefined,
      roles: [],
      pendingOrganizations: [],
    });
  },

  bootstrap: async () => {
    try {
      const me = await authApi.me();
      if (!me.organizationId) {
        // Session exists but no org context yet (mid multi-org
        // selection from a prior visit) — treat as unauthenticated;
        // the login flow re-derives the org list on next login rather
        // than persisting it across a page reload.
        set({ status: 'unauthenticated' });
        return;
      }
      set({
        status: 'authenticated',
        userId: me.id,
        organizationId: me.organizationId,
        roles: me.roles ?? [],
      });
    } catch (error) {
      if (isAuthenticationError(error)) {
        set({ status: 'unauthenticated' });
        return;
      }
      throw error;
    }
  },
}));

/**
 * Wired once at app boot (see src/main.tsx). Covers the just-shipped
 * backend session-revocation path too — a deactivated membership's
 * cookie now dies immediately, and the very next request anywhere in
 * the app will 401 into this same handler.
 */
export function installUnauthorizedHandler(): void {
  setUnauthorizedHandler(() => {
    queryClient.clear();
    useSessionStore.getState().clear();
  });
}

/**
 * §8 of the approved plan: switchOrganization is a "full context
 * switch, never a partial merge" — reset the query cache before
 * applying the new session, not after, so no stale org-A data can
 * flash before org-B's queries refetch.
 */
export function resetContextForOrganizationSwitch(): void {
  queryClient.clear();
}
