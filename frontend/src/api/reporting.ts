import { apiRequest } from './client';
import { notImplemented } from './notImplemented';

export interface SearchResultLoad {
  id: string;
  loadNumber: string;
  status: string;
  customerId: string;
}

export interface SearchResultCustomer {
  id: string;
  legalName: string;
  status: string;
}

export interface SearchResultCarrier {
  id: string;
  legalName: string;
  status: string;
}

export interface SearchResultInvoice {
  id: string;
  invoiceNumber: string;
  status: string;
  total: string | null;
}

export interface GlobalSearchResult {
  loads: SearchResultLoad[];
  customers: SearchResultCustomer[];
  carriers: SearchResultCarrier[];
  invoices: SearchResultInvoice[];
}

export interface AgingBucket {
  count: number;
  total: string;
}

export interface AgingBuckets {
  current: AgingBucket;
  days1to30: AgingBucket;
  days31to60: AgingBucket;
  days61to90: AgingBucket;
  days90plus: AgingBucket;
}

export interface AgingReport {
  buckets: AgingBuckets;
  grandTotal: string;
}

export const reportingApi = {
  search: (q: string) => apiRequest<GlobalSearchResult>('/search', { query: { q } }),

  /** DATABASE_DESIGN.md §21 / Decision D14 — buckets Invoices outstanding by due_date. Admin/Accounting/Ops Manager only. */
  arAging: () => apiRequest<AgingReport>('/reports/ar-aging'),

  /** Decision D14 — buckets CarrierPayments by submitted_at. Admin/Accounting/Ops Manager only. */
  apAging: () => apiRequest<AgingReport>('/reports/ap-aging'),

  // Typed surface only — the backend's GET /dashboard is fully built, but
  // Dashboard has no locked screen-level design (widget/KPI layout) to
  // build a frontend against yet (Frontend Phase 7/8/9 inspections).
  dashboard: (): Promise<unknown> => notImplemented('reportingApi.dashboard'),
  // NOTE: the broader Operations/Financial/Carrier-Performance/Sales
  // report library, CSV/Excel export, and saved views have no backend
  // endpoints — deferred to a later phase per the approved gap analysis.
};
