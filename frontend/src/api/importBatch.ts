import { apiRequest } from './client';

/**
 * Bulk CSV/Excel Import (PRD.md §1.4, §6.9, §10.1, §13). Matches
 * `backend/src/modules/import/services/import-batch.service.ts`'s exact
 * response shapes.
 */
export type ImportEntityType =
  | 'CUSTOMER'
  | 'CUSTOMER_CONTACT'
  | 'CUSTOMER_LOCATION'
  | 'CARRIER'
  | 'CARRIER_CONTACT'
  | 'DRIVER'
  | 'TRUCK'
  | 'TRAILER';

export type ImportBatchStatus =
  'UPLOADED' | 'MAPPING' | 'VALIDATED' | 'IMPORTING' | 'COMPLETE' | 'FAILED';
export type ImportRowStatus = 'VALID' | 'INVALID' | 'IMPORTED' | 'FAILED' | 'SKIPPED';

export interface ImportBatch {
  id: string;
  entityType: ImportEntityType;
  status: ImportBatchStatus;
  fileName: string;
  fileFormat: 'CSV' | 'XLSX';
  columnMapping: Record<string, string | null> | null;
  totalRows: number | null;
  validRowCount: number | null;
  invalidRowCount: number | null;
  importedRowCount: number | null;
  failedRowCount: number | null;
  skippedRowCount: number | null;
  createdAt: string;
  validatedAt: string | null;
  completedAt: string | null;
}

export interface ImportFieldSpec {
  key: string;
  label: string;
  required: boolean;
}

export interface ImportBatchRow {
  id: string;
  rowNumber: number;
  rawData: Record<string, string>;
  mappedData: Record<string, unknown>;
  status: ImportRowStatus;
  errors: string[] | null;
  duplicateWarning: unknown[] | null;
  acknowledgeDuplicate: boolean;
  createdEntityId: string | null;
}

export interface PagedRows {
  items: ImportBatchRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ConfirmUploadResult {
  headers: string[];
  suggestedMapping: Record<string, string | null>;
  targetFields: ImportFieldSpec[];
}

export const IMPORT_ENTITY_LABELS: Record<ImportEntityType, string> = {
  CUSTOMER: 'Customers',
  CUSTOMER_CONTACT: 'Customer Contacts',
  CUSTOMER_LOCATION: 'Customer Locations',
  CARRIER: 'Carriers',
  CARRIER_CONTACT: 'Carrier Contacts',
  DRIVER: 'Drivers',
  TRUCK: 'Trucks',
  TRAILER: 'Trailers',
};

export const importBatchApi = {
  create: (body: { entityType: ImportEntityType; fileName: string; fileFormat: 'CSV' | 'XLSX' }) =>
    apiRequest<{ importBatch: ImportBatch; uploadUrl: string }>('/import-batches', {
      method: 'POST',
      body,
    }),

  confirmUpload: (id: string) =>
    apiRequest<ConfirmUploadResult>(`/import-batches/${id}/confirm-upload`, { method: 'POST' }),

  submitMapping: (id: string, columnMapping: Record<string, string | null>) =>
    apiRequest<ImportBatch>(`/import-batches/${id}/mapping`, {
      method: 'PATCH',
      body: { columnMapping },
    }),

  listRows: (
    id: string,
    filters: { status?: ImportRowStatus; page?: number; pageSize?: number } = {},
  ) => apiRequest<PagedRows>(`/import-batches/${id}/rows`, { query: filters }),

  updateRow: (id: string, rowId: string, acknowledgeDuplicate: boolean) =>
    apiRequest<ImportBatchRow>(`/import-batches/${id}/rows/${rowId}`, {
      method: 'PATCH',
      body: { acknowledgeDuplicate },
    }),

  commit: (id: string) =>
    apiRequest<ImportBatch>(`/import-batches/${id}/commit`, { method: 'POST' }),

  getById: (id: string) => apiRequest<ImportBatch>(`/import-batches/${id}`),

  list: (entityType?: ImportEntityType) =>
    apiRequest<ImportBatch[]>('/import-batches', { query: { entityType } }),
};
