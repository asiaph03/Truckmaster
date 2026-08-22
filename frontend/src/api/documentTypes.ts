import type { DocumentTypeCategory } from '@tms/shared-constants';
import { apiRequest } from './client';

export interface DocumentTypeDefinition {
  id: string;
  organizationId: string | null;
  category: DocumentTypeCategory;
  code: string;
  label: string;
  requiresReview: boolean;
  isSystemDefault: boolean;
}

/** Backs `GET /document-types` — the Phase 2 gap-fix endpoint (read-only). */
export const documentTypesApi = {
  list: (category?: DocumentTypeCategory) =>
    apiRequest<DocumentTypeDefinition[]>('/document-types', { query: { category } }),
};
