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
 * Phase 5 — the only lever a caller has over demo/trial provisioning.
 * Omitted (or STANDARD) preserves the exact pre-Phase-5 behavior; the
 * resulting subscription/trial values are always server-computed, never
 * client-supplied.
 */
export type ProvisioningMode = 'STANDARD' | 'DEMO';

/**
 * Platform-console org creation (`POST /platform/organizations`,
 * PlatformSuperAdminGuard). Deliberately NOT the same shape as
 * `UpdateOrganizationRequest` — `CreateOrganizationDto` has no
 * `defaultPaymentTerms` field at all (it defaults to NET_30 server-side,
 * editable afterward only via `update()` above), and every field except
 * `country` and `provisioningMode` is required at creation time.
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
  provisioningMode?: ProvisioningMode;
}

/** Phase 4 — subscriptionStatus values. Deliberately separate from Organization.status (access/suspension), unchanged by this phase. */
export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';

/** Phase 4 — `GET /platform/organizations` summary row. No address/contact/payment-terms fields — kept minimal per the locked design. */
export interface PlatformOrganizationSummary {
  id: string;
  legalName: string;
  subscriptionStatus: SubscriptionStatus;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  maxCarriers: number | null;
  maxDrivers: number | null;
}

/** Phase 4 — `GET /platform/organizations/:id` detail, including current qualifying usage (the same Phase 2 qualifying definitions: Carrier status PENDING/ACTIVE, Driver active=true). */
export interface PlatformOrganizationDetail {
  id: string;
  legalName: string;
  primaryContactName: string;
  primaryContactEmail: string;
  status: string;
  createdAt: string;
  subscriptionStatus: SubscriptionStatus;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  maxCarriers: number | null;
  maxDrivers: number | null;
  subscriptionConvertedAt: string | null;
  subscriptionConvertedByUserId: string | null;
  qualifyingCarrierCount: number;
  qualifyingDriverCount: number;
}

/** Phase 4 — the endpoint itself always converts to ACTIVE; the client never supplies subscriptionStatus. */
export interface ConvertOrganizationSubscriptionRequest {
  maxCarriers: number | null;
  maxDrivers: number | null;
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

  /** Phase 4 — platform-console org list, PlatformSuperAdminGuard. No pagination at current scale. */
  list: () => apiRequest<PlatformOrganizationSummary[]>('/platform/organizations'),

  /** Phase 4 — platform-console org detail, PlatformSuperAdminGuard. */
  getById: (id: string) => apiRequest<PlatformOrganizationDetail>(`/platform/organizations/${id}`),

  /** Phase 4 — TRIAL/EXPIRED → ACTIVE conversion, PlatformSuperAdminGuard. */
  convertSubscription: (id: string, body: ConvertOrganizationSubscriptionRequest) =>
    apiRequest<PlatformOrganizationDetail>(`/platform/organizations/${id}/subscription`, {
      method: 'PATCH',
      body,
    }),
};
