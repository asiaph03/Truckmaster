import { apiRequest } from './client';

export type CarrierPaymentStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID';
export type CarrierPaymentType = 'DEPOSIT' | 'PARTIAL' | 'BALANCE' | 'ADJUSTMENT';

export interface CarrierPayment {
  id: string;
  organizationId: string;
  loadId: string;
  carrierId: string;
  amount: string;
  paymentType: CarrierPaymentType;
  method?: string;
  referenceNumber?: string;
  notes?: string;
  status: CarrierPaymentStatus;
  preparedByUserId: string;
  submittedAt?: string;
  approvedByUserId?: string;
  approvedAt?: string;
  lastRejectedByUserId?: string;
  lastRejectedAt?: string;
  lastRejectionReason?: string;
  paidAt?: string;
  createdAt: string;
}

export interface CarrierPaymentListFilters {
  loadId?: string;
  status?: string;
}

/**
 * There is no update/PATCH endpoint for a Draft Carrier Payment (verified
 * against the full backend route surface) — `method`/`referenceNumber`
 * can only ever be set here, at creation, even though the backend types
 * them optional for the Draft stage itself. `submit` requires both to
 * already be non-null, so the Create form collects them upfront rather
 * than leaving a Draft with no path to ever being submitted.
 */
export interface CreateCarrierPaymentRequest {
  paymentType: CarrierPaymentType;
  amount: string;
  method: string;
  referenceNumber: string;
  notes?: string;
}

export interface RejectCarrierPaymentRequest {
  reason: string;
}

export interface MarkPaidRequest {
  paymentDate?: string;
}

/**
 * Accessorial Charges on in-transit Loads — read-only pre-creation
 * balance preview (carrierRate + carrier-side accessorial charges minus
 * already-Paid), so CreateCarrierPaymentModal can show Accounting the
 * correct figure before they type an Amount. `carrierRate`/
 * `remainingCarrierBalance` are null when the Load has no carrierRate set
 * yet.
 */
export interface CarrierPaymentRemainingBalance {
  carrierRate: string | null;
  carrierAccessorialsTotal: string;
  totalPaid: string;
  remainingCarrierBalance: string | null;
}

export const carrierPayApi = {
  create: (loadId: string, body: CreateCarrierPaymentRequest) =>
    apiRequest<CarrierPayment>(`/loads/${loadId}/carrier-payments`, { method: 'POST', body }),

  getRemainingBalance: (loadId: string) =>
    apiRequest<CarrierPaymentRemainingBalance>(
      `/loads/${loadId}/carrier-payments/remaining-balance`,
    ),

  list: (filters?: CarrierPaymentListFilters) =>
    apiRequest<CarrierPayment[]>('/carrier-payments', { query: filters }),

  getById: (id: string) => apiRequest<CarrierPayment>(`/carrier-payments/${id}`),

  submit: (id: string) =>
    apiRequest<CarrierPayment>(`/carrier-payments/${id}/submit`, { method: 'POST' }),

  /** ADMIN only — self-review blocked server-side (403 `SELF_REVIEW_FORBIDDEN`). */
  approve: (id: string) =>
    apiRequest<CarrierPayment>(`/carrier-payments/${id}/approve`, { method: 'POST' }),

  /** ADMIN only — same self-review block as approve; loops the payment back to DRAFT. */
  reject: (id: string, body: RejectCarrierPaymentRequest) =>
    apiRequest<CarrierPayment>(`/carrier-payments/${id}/reject`, { method: 'POST', body }),

  markPaid: (id: string, body?: MarkPaidRequest) =>
    apiRequest<CarrierPayment>(`/carrier-payments/${id}/mark-paid`, { method: 'POST', body }),
};
