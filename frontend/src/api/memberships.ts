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

export interface UpdateMembershipRolesRequest {
  roles: MembershipRoleName[];
}

/**
 * `GET /memberships` was already used by Customer Overview's "Assign
 * Account Owner" picker and the Dispatch Board's dispatcher filter.
 * invite/resend/cancel/deactivate are Frontend Phase 5 additions for the
 * Settings → Users & Roles screen. `updateRoles` is a Frontend Phase 11
 * addition — replaces an active member's full role set; server-side
 * enforces the last-active-Admin protection (never trust a client-side
 * check for this), so a rejected call surfaces as a normal ApiError with
 * the backend's own message, not a client-computed one.
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

  updateRoles: (id: string, body: UpdateMembershipRolesRequest) =>
    apiRequest<MembershipListItem>(`/memberships/${id}/roles`, { method: 'PATCH', body }),
};
