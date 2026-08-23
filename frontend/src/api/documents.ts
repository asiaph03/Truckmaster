import { apiRequest } from './client';

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

export interface InitiateUploadResponse {
  document: AppDocument;
  uploadUrl: string;
}

export interface ReviewDocumentRequest {
  decision: 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
}

export const documentsApi = {
  list: (entityType: DocumentEntityType, entityId: string) =>
    apiRequest<AppDocument[]>('/documents', { query: { entityType, entityId } }),

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
};
