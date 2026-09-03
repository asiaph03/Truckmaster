import { apiRequest } from './client';
import type { CustomerStatus } from './customers';
import type { ExtractedRateConfirmationData } from './rateConfirmationExtraction';

/**
 * Rate Confirmation → New Load auto-populate feature — Load Draft.
 * Persists an already-completed extraction result (Postgres, durable)
 * so a user who has to leave the New Load page while a new/non-Active
 * Customer awaits approval never has to re-upload the PDF or trigger a
 * second extraction. No status field — `customerStatus` here is always
 * the customer's LIVE status, so "waiting" vs. "ready to book" is
 * derived the exact same way LoadCreatePage already derives it for any
 * selected customer, never a separately-tracked flag that could drift.
 */
export interface LoadDraftSummary {
  id: string;
  customerId: string;
  customerLegalName: string;
  customerStatus: CustomerStatus;
  rateConfirmationDocumentId: string;
  rateConfirmationFileName: string;
  createdAt: string;
}

export interface LoadDraft extends LoadDraftSummary {
  extractedData: ExtractedRateConfirmationData;
}

export interface CreateLoadDraftRequest {
  extractionId: string;
  customerId: string;
  extractedData: ExtractedRateConfirmationData;
}

export const loadDraftsApi = {
  create: (body: CreateLoadDraftRequest) =>
    apiRequest<LoadDraft>('/load-drafts', { method: 'POST', body }),

  list: () => apiRequest<LoadDraftSummary[]>('/load-drafts'),

  get: (id: string) => apiRequest<LoadDraft>(`/load-drafts/${id}`),

  remove: (id: string) => apiRequest<void>(`/load-drafts/${id}`, { method: 'DELETE' }),
};
