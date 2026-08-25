import type { MembershipRoleName } from '@tms/shared-constants';
import { apiRequest } from './client';

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'CANCELLED' | 'INACTIVE' | 'EXPIRED';

export interface MembershipListItem {
  id: string;
  userId: string;
  status: MembershipStatus;
  user: { id: string; name: string; email: string };
  roles: { role: MembershipRoleName }[];
}

export interface InviteMemberRequest {
  email: string;
  roles: MembershipRoleName[];
}

/**
 * `GET /memberships` was already used by Customer Overview's "Assign
 * Account Owner" picker and the Dispatch Board's dispatcher filter.
 * invite/resend/cancel/deactivate are Frontend Phase 5 additions for the
 * Settings → Users & Roles screen — there is no role-change endpoint on
 * the backend (`MembershipsController` only exposes those four actions,
 * all Admin-only), so this client deliberately has no `updateRoles`
 * method: inventing one client-side would build a UI action that always
 * 404s.
 */
export const membershipsApi = {
  list: () => apiRequest<MembershipListItem[]>('/memberships'),

  invite: (body: InviteMemberRequest) =>
    apiRequest<MembershipListItem>('/memberships/invite', { method: 'POST', body }),

  resend: (id: string) =>
    apiRequest<MembershipListItem>(`/memberships/${id}/resend`, { method: 'POST' }),

  cancel: (id: string) =>
    apiRequest<MembershipListItem>(`/memberships/${id}/cancel`, { method: 'POST' }),

  deactivate: (id: string) =>
    apiRequest<MembershipListItem>(`/memberships/${id}/deactivate`, { method: 'POST' }),
};
