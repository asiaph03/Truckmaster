import type { MembershipRoleName } from '@tms/shared-constants';
import { apiRequest } from './client';

export interface OrganizationSummary {
  id: string;
  legalName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  requiresOrganizationSelection: boolean;
  organizations: OrganizationSummary[];
}

export interface SelectOrganizationRequest {
  organizationId: string;
}

export interface SelectOrganizationResponse {
  organizationId: string;
  roles: MembershipRoleName[];
}

export interface ActivateMembershipRequest {
  token: string;
  password?: string;
}

export interface ActivateMembershipResponse {
  membershipId: string;
  organizationId: string;
}

export interface CurrentUserResponse {
  // The backend spreads AuthService.getProfile()'s result (whose id field
  // is `id`, not `userId`) alongside session-derived organizationId/roles
  // — see auth.controller.ts `me()`. Confirmed against the real response
  // during Phase 1 manual verification, not assumed from the DTO name.
  id: string;
  name?: string;
  email?: string;
  organizationId?: string;
  roles?: MembershipRoleName[];
}

export interface UpdateProfileRequest {
  name?: string;
  password?: string;
}

export const authApi = {
  login: (body: LoginRequest) => apiRequest<LoginResponse>('/auth/login', { method: 'POST', body }),

  activate: (body: ActivateMembershipRequest) =>
    apiRequest<ActivateMembershipResponse>('/auth/activate', { method: 'POST', body }),

  selectOrganization: (body: SelectOrganizationRequest) =>
    apiRequest<SelectOrganizationResponse>('/auth/select-organization', { method: 'POST', body }),

  switchOrganization: (body: SelectOrganizationRequest) =>
    apiRequest<SelectOrganizationResponse>('/auth/switch-organization', { method: 'POST', body }),

  logout: () => apiRequest<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => apiRequest<CurrentUserResponse>('/auth/me'),

  updateMe: (body: UpdateProfileRequest) =>
    apiRequest<{ success: boolean }>('/auth/me', { method: 'PATCH', body }),
};
