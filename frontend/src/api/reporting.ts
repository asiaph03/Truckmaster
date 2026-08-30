import { API_BASE, apiRequest } from './client';
import { ApiError } from './errors';

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

/**
 * Frontend Phase 10 — matches ReportingService.dashboard()'s exact shape
 * (backend/src/modules/reporting/services/reporting.service.ts). Every
 * key is optional: the backend includes only the blocks the caller's
 * role(s) qualify for, so a Compliance-Reviewer-only session gets `{}`.
 */
export interface DashboardDispatcherBlock {
  activeLoads: number;
  atRiskOrDelayed: number;
  overdueCheckCalls: number;
}

export interface DashboardSalesBlock {
  openQuotes: number;
  wonLast30: number;
  lostLast30: number;
  winRate: number;
}

export interface DashboardAccountingBlock {
  arOutstanding: string;
  arOverdue: string;
  apOutstanding: string;
  pendingCarrierPayments: number;
}

export interface DashboardResponse {
  dispatcher?: DashboardDispatcherBlock;
  sales?: DashboardSalesBlock;
  accounting?: DashboardAccountingBlock;
}

export const reportingApi = {
  search: (q: string) => apiRequest<GlobalSearchResult>('/search', { query: { q } }),

  /** DATABASE_DESIGN.md §21 / Decision D14 — buckets Invoices outstanding by due_date. Admin/Accounting/Ops Manager only. */
  arAging: () => apiRequest<AgingReport>('/reports/ar-aging'),

  /** Decision D14 — buckets CarrierPayments by submitted_at. Admin/Accounting/Ops Manager only. */
  apAging: () => apiRequest<AgingReport>('/reports/ap-aging'),

  /** PRD §9 role-aware Dashboard — open to any authenticated session; role-filtering happens entirely server-side. */
  dashboard: () => apiRequest<DashboardResponse>('/dashboard'),

  /** Phase 21 (Reports Library) — identical bucket data as `arAging`, as a CSV download. */
  arAgingExportCsv: () => downloadCsv('/reports/ar-aging/export', 'ar-aging.csv'),

  /** Phase 21 (Reports Library) — identical bucket data as `apAging`, as a CSV download. */
  apAgingExportCsv: () => downloadCsv('/reports/ap-aging/export', 'ap-aging.csv'),
};

/**
 * Not routed through `apiRequest` — these endpoints return a raw CSV file,
 * not JSON. Mirrors `loadsApi.exportSearchCsv`/`documentsApi.exportSearchCsv`'s
 * exact approach: a normal browser file download via a throwaway object URL.
 */
async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
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
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
