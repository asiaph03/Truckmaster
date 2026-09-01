import { API_BASE, apiRequest } from './client';
import { ApiError } from './errors';
import type { DocumentTypeDefinition } from './documentTypes';

export type DocumentEntityType =
  | 'LOAD'
  | 'STOP'
  | 'CUSTOMER'
  | 'CARRIER'
  | 'DRIVER'
  | 'TRUCK'
  | 'TRAILER'
  | 'INVOICE'
  | 'CARRIER_PAYMENT';

export type DocumentScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED';
export type DocumentReviewStatus =
  'NOT_APPLICABLE' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
/** Nullable — only Rate Confirmation/Invoice/Settlement documents are system-generated (Phase 16). */
export type DocumentGenerationStatus = 'PENDING' | 'COMPLETE' | 'FAILED';

export interface AppDocument {
  id: string;
  entityType: DocumentEntityType;
  entityId: string;
  documentTypeId: string;
  customTypeLabel?: string;
  fileName: string;
  mimeType: string;
  // Prisma BigInt column — the backend patches BigInt.prototype.toJSON to
  // serialize as a string, never a JS number (configure-app.ts).
  fileSizeBytes: string;
  fileStorageKey: string;
  versionNumber: number;
  isCurrentVersion: boolean;
  scanStatus: DocumentScanStatus;
  reviewStatus: DocumentReviewStatus;
  generationStatus?: DocumentGenerationStatus | null;
  rejectionReason?: string;
  uploadedByUserId: string;
  uploadedAt: string;
  reviewedByUserId?: string;
  reviewedAt?: string;
  expirationDate?: string;
}

export interface UploadCarrierDocumentRequest {
  documentTypeId: string;
  customTypeLabel?: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  existingDocumentFamilyId?: string;
  expirationDate?: string;
}

export interface CreateDocumentRequest {
  entityType: DocumentEntityType;
  entityId: string;
  documentTypeId: string;
  customTypeLabel?: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  existingDocumentFamilyId?: string;
  expirationDate?: string;
}

export interface UploadPodDocumentRequest {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  existingDocumentFamilyId?: string;
}

/** Same shape as UploadPodDocumentRequest — the symmetric pickup-side (POP) request. */
export type UploadPopDocumentRequest = UploadPodDocumentRequest;

export interface InitiateUploadResponse {
  document: AppDocument;
  uploadUrl: string;
}

export interface ReviewDocumentRequest {
  decision: 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
}

/**
 * Frontend Phase 5 — Carrier Compliance Review Queue. `entityId` is
 * always a Carrier id on this endpoint (the backend gap-fix scopes
 * `GET /documents/pending-review` to `entityType: 'CARRIER'` only).
 * `carrierLegalName` is resolved server-side since `entityId` has no
 * native FK to join through.
 */
export interface PendingReviewDocument extends AppDocument {
  documentType: DocumentTypeDefinition;
  carrierLegalName: string | null;
}

export type DocumentSearchSort = 'fileName' | 'documentType' | 'uploadedAt';
export type DocumentSearchSortDirection = 'asc' | 'desc';

/**
 * Frontend Phase 20 (Document Center) — a dedicated `GET /documents/search`
 * request shape, separate from `list()` above (entity-scoped) and from
 * GlobalSearch (deliberately not extended, per the approved design).
 */
export interface DocumentSearchFilters {
  q?: string;
  entityType?: DocumentEntityType;
  documentTypeId?: string;
  scanStatus?: DocumentScanStatus;
  reviewStatus?: DocumentReviewStatus;
  generationStatus?: DocumentGenerationStatus;
  uploadedFrom?: string;
  uploadedTo?: string;
  sort?: DocumentSearchSort;
  sortDirection?: DocumentSearchSortDirection;
  page?: number;
  pageSize?: number;
}

/**
 * One row per matching Document, with its owning entity's display
 * identifier and detail-page link pre-resolved server-side (the entity
 * link is never the whole row — a single "Owning Entity" column with an
 * explicit link, per the approved decision).
 */
export interface DocumentSearchResultRow {
  id: string;
  fileName: string;
  documentTypeLabel: string;
  entityType: DocumentEntityType;
  entityId: string;
  entityLabel: string;
  entityLinkPath: string;
  scanStatus: DocumentScanStatus;
  reviewStatus: DocumentReviewStatus | null;
  generationStatus: DocumentGenerationStatus | null;
  uploadedByUserId: string;
  uploadedByName: string;
  uploadedAt: string;
}

export interface DocumentSearchResult {
  items: DocumentSearchResultRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Mirrors `loadsApi`'s own array-free query serialization — Document Center's filters carry no array-valued params. */
function buildDocumentSearchQueryString(filters: DocumentSearchFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export const documentsApi = {
  search: (filters: DocumentSearchFilters) =>
    apiRequest<DocumentSearchResult>('/documents/search', { query: filters }),

  /**
   * Not routed through `apiRequest` — this endpoint returns a raw CSV
   * file, not JSON. Mirrors `loadsApi.exportSearchCsv`'s exact approach:
   * same server-side filters/authorization as the interactive results
   * (decision — see the approved plan), triggered as a normal browser
   * file download.
   */
  exportSearchCsv: async (filters: DocumentSearchFilters): Promise<void> => {
    const qs = buildDocumentSearchQueryString(filters);
    const response = await fetch(`${API_BASE}/documents/search/export${qs ? `?${qs}` : ''}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new ApiError(
        response.status,
        payload?.error ?? { code: 'INTERNAL_ERROR', message: 'Export failed' },
      );
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'document-center-export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

  list: (entityType: DocumentEntityType, entityId: string) =>
    apiRequest<AppDocument[]>('/documents', { query: { entityType, entityId } }),

  /** Compliance-Reviewer-only, matching `review()`'s own role restriction. */
  listPendingReview: () => apiRequest<PendingReviewDocument[]>('/documents/pending-review'),

  uploadCarrierDocument: (carrierId: string, body: UploadCarrierDocumentRequest) =>
    apiRequest<InitiateUploadResponse>(`/carriers/${carrierId}/documents`, {
      method: 'POST',
      body,
    }),

  /** Generic polymorphic upload — used by Load Detail's Documents tab for Load-level documents. */
  create: (body: CreateDocumentRequest) =>
    apiRequest<InitiateUploadResponse>('/documents', { method: 'POST', body }),

  uploadPodDocument: (loadId: string, sequence: number, body: UploadPodDocumentRequest) =>
    apiRequest<InitiateUploadResponse>(`/loads/${loadId}/stops/${sequence}/pod-documents`, {
      method: 'POST',
      body,
    }),

  uploadPopDocument: (loadId: string, sequence: number, body: UploadPopDocumentRequest) =>
    apiRequest<InitiateUploadResponse>(`/loads/${loadId}/stops/${sequence}/pop-documents`, {
      method: 'POST',
      body,
    }),

  confirmUpload: (documentId: string) =>
    apiRequest<AppDocument>(`/documents/${documentId}/confirm`, { method: 'POST' }),

  getDownloadUrl: (documentId: string) =>
    apiRequest<{ url: string }>(`/documents/${documentId}/download-url`),

  review: (documentId: string, body: ReviewDocumentRequest) =>
    apiRequest<AppDocument>(`/documents/${documentId}/review`, { method: 'POST', body }),

  /**
   * `PUT`s the raw file bytes directly to the presigned S3-compatible
   * URL from `InitiateUploadResponse` — never goes through `apiRequest`
   * (different origin, no session cookie/JSON envelope involved).
   */
  putFileToUploadUrl: async (uploadUrl: string, file: File): Promise<void> => {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!response.ok) {
      throw new Error(`File upload failed (${response.status}).`);
    }
  },

  /**
   * Orchestrates the full two-phase carrier-document upload (initiate →
   * PUT → confirm) as one call — the shape `FileUploadField.onUpload`
   * expects. Returns the new document's id.
   */
  uploadCarrierDocumentAndConfirm: async (
    carrierId: string,
    meta: Omit<UploadCarrierDocumentRequest, 'fileSizeBytes' | 'fileName' | 'mimeType'>,
    file: File,
  ): Promise<string> => {
    const { document, uploadUrl } = await documentsApi.uploadCarrierDocument(carrierId, {
      ...meta,
      fileName: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
    });
    await documentsApi.putFileToUploadUrl(uploadUrl, file);
    await documentsApi.confirmUpload(document.id);
    return document.id;
  },

  /** Same two-phase orchestration as `uploadCarrierDocumentAndConfirm`, for Load-level documents. */
  uploadLoadDocumentAndConfirm: async (
    meta: Omit<CreateDocumentRequest, 'fileSizeBytes' | 'fileName' | 'mimeType'>,
    file: File,
  ): Promise<string> => {
    const { document, uploadUrl } = await documentsApi.create({
      ...meta,
      fileName: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
    });
    await documentsApi.putFileToUploadUrl(uploadUrl, file);
    await documentsApi.confirmUpload(document.id);
    return document.id;
  },

  /** Same two-phase orchestration, for a delivery Stop's POD (Workflow 7 §7.1). */
  uploadPodDocumentAndConfirm: async (
    loadId: string,
    sequence: number,
    meta: Omit<UploadPodDocumentRequest, 'fileSizeBytes' | 'fileName' | 'mimeType'>,
    file: File,
  ): Promise<string> => {
    const { document, uploadUrl } = await documentsApi.uploadPodDocument(loadId, sequence, {
      ...meta,
      fileName: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
    });
    await documentsApi.putFileToUploadUrl(uploadUrl, file);
    await documentsApi.confirmUpload(document.id);
    return document.id;
  },

  /** Same two-phase orchestration, for a pickup Stop's POP. */
  uploadPopDocumentAndConfirm: async (
    loadId: string,
    sequence: number,
    meta: Omit<UploadPopDocumentRequest, 'fileSizeBytes' | 'fileName' | 'mimeType'>,
    file: File,
  ): Promise<string> => {
    const { document, uploadUrl } = await documentsApi.uploadPopDocument(loadId, sequence, {
      ...meta,
      fileName: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size,
    });
    await documentsApi.putFileToUploadUrl(uploadUrl, file);
    await documentsApi.confirmUpload(document.id);
    return document.id;
  },

  /**
   * There is no `GET /documents/:id` single-fetch endpoint — scan-status
   * polling re-lists the entity's documents and finds the match, per the
   * actual backend API surface.
   */
  checkScanStatus: async (
    entityType: DocumentEntityType,
    entityId: string,
    documentId: string,
  ): Promise<DocumentScanStatus> => {
    const docs = await documentsApi.list(entityType, entityId);
    const found = docs.find((d) => d.id === documentId);
    return found?.scanStatus ?? 'PENDING';
  },

  /**
   * Frontend Phase 4 approved decision 4 (Invoice PDF / Settlement
   * readiness): `POST /invoices/:id/send` and
   * `POST /carrier-payments/:id/mark-paid` both create the Document row
   * synchronously with `fileSizeBytes: 0` and enqueue a job that fills in
   * the real PDF asynchronously. No backend readiness endpoint exists by
   * design — this polls `GET /documents` every ~2s (mirroring
   * `FileUploadField`'s `pollUntilResolved` cadence exactly) for up to 30
   * attempts, resolving once a document for this entity has
   * `fileSizeBytes > 0`. Returns `null` on timeout — the document keeps
   * generating server-side and will show correctly on next reload.
   *
   * Phase 16 — also resolves early on `generationStatus === 'FAILED'`
   * (terminal, after 3 retries) so callers don't poll the full 30
   * attempts for a document that will never gain bytes.
   */
  waitForDocumentReady: async (
    entityType: DocumentEntityType,
    entityId: string,
  ): Promise<AppDocument | null> => {
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const docs = await documentsApi.list(entityType, entityId);
      const ready = docs.find(
        (d) => Number(d.fileSizeBytes) > 0 || d.generationStatus === 'FAILED',
      );
      if (ready) return ready;
    }
    return null;
  },
};

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;
