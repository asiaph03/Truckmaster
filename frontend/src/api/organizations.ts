import type { PaymentTerms } from '@tms/shared-constants';
import { apiRequest } from './client';

/**
 * Frontend Phase 14 — Organization Settings. `GET`/`PATCH
 * /organizations/current` are org-scoped (organizationId always comes
 * from the authenticated session server-side, never a client param) and
 * are deliberately distinct from anything under `/platform/organizations`
 * (the platform-console org-provisioning route, untouched by this phase).
 */
export interface Organization {
  id: string;
  legalName: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  defaultPaymentTerms: PaymentTerms;
  status: string;
  createdAt: string;
}

/**
 * Exactly the 10 approved editable fields — no `id`/`createdByUserId`/
 * `createdAt`/`status`. All optional: the backend accepts (and this
 * screen sends) a partial update.
 */
export interface UpdateOrganizationRequest {
  legalName?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  defaultPaymentTerms?: PaymentTerms;
}

/**
 * Platform-console org creation (`POST /platform/organizations`,
 * PlatformSuperAdminGuard). Deliberately NOT the same shape as
 * `UpdateOrganizationRequest` — `CreateOrganizationDto` has no
 * `defaultPaymentTerms` field at all (it defaults to NET_30 server-side,
 * editable afterward only via `update()` above), and every field except
 * `country` is required at creation time.
 */
export interface CreateOrganizationRequest {
  legalName: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
}

export const organizationsApi = {
  getCurrent: () => apiRequest<Organization>('/organizations/current'),

  update: (body: UpdateOrganizationRequest) =>
    apiRequest<Organization>('/organizations/current', { method: 'PATCH', body }),

  create: (body: CreateOrganizationRequest) =>
    apiRequest<{ organization: Organization }>('/platform/organizations', {
      method: 'POST',
      body,
    }),
};
