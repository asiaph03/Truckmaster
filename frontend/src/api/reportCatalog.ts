import { API_BASE, apiRequest } from './client';
import { ApiError } from './errors';

/**
 * Phase 21 (Reports Library) — matches
 * `backend/src/modules/reporting/services/report-catalog.service.ts`'s
 * exact response shapes.
 */
export interface ReportCatalogEntry {
  id: string;
  title: string;
  externalPath?: string;
}

export interface ReportCatalogCategory {
  key: string;
  label: string;
  reports: ReportCatalogEntry[];
}

export interface ReportCatalogResponse {
  categories: ReportCatalogCategory[];
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaymentHistoryRow {
  id: string;
  type: 'PAYMENT' | 'ADJUSTMENT';
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  amount: string;
  method: string | null;
  adjustmentType: 'CREDIT' | 'DEBIT' | null;
  referenceNumber: string | null;
  reason: string | null;
  recordedByName: string;
}

export interface PaymentHistoryResult extends PagedResult<PaymentHistoryRow> {
  truncated: boolean;
}

export type RevenueMarginGroupBy = 'CUSTOMER' | 'CARRIER' | 'LANE' | 'MONTH';

export interface RevenueMarginRow {
  groupKey: string;
  groupLabel: string;
  loadCount: number;
  revenue: string;
  cost: string;
  grossProfit: string;
  marginPercent: string;
}

export interface RevenueMarginResult extends PagedResult<RevenueMarginRow> {
  previousPeriod?: RevenueMarginRow[];
}

export type LoadVolumeBucket = 'DAY' | 'WEEK' | 'MONTH';

export interface LoadVolumeRow {
  period: string;
  loadCount: number;
}

export interface StatusMixRow {
  status: string;
  count: number;
  percentOfTotal: string;
}

export type OnTimeGroupBy = 'CARRIER' | 'DISPATCHER';

export interface OnTimeRow {
  groupKey: string;
  groupLabel: string;
  deliveriesEvaluated: number;
  onTimeCount: number;
  onTimePercent: string;
  excludedNoAppointment: number;
}

export interface DispatcherWorkloadRow {
  dispatcherId: string;
  dispatcherName: string;
  loadsAssigned: number;
  active: number;
  deliveredOrClosed: number;
}

export interface CarrierPerformanceRow {
  carrierId: string;
  carrierLegalName: string;
  loadCount: number;
  rejectionRatePercent: string;
  onTimePercent: string | null;
  totalCost: string | null;
  avgCostPerLoad: string | null;
}

export interface SalesPerformanceRow {
  repUserId: string;
  repName: string;
  quotesCreated: number;
  won: number;
  lost: number;
  winRatePercent: string;
  revenue: string;
  grossProfit: string | null;
}

export interface DateRangeFilters {
  dateFrom?: string;
  dateTo?: string;
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

/**
 * Not routed through `apiRequest` — every `/export` route returns a raw
 * CSV file, not JSON. `query` is deliberately `object`, not
 * `Record<string, ...>` — mirrors `client.ts`'s own `RequestOptions.query`
 * — a named filter interface has no index signature and won't
 * structurally match a `Record<string, T>` parameter.
 */
async function downloadCsv(path: string, query: object, filename: string): Promise<void> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  const response = await fetch(`${API_BASE}${path}${qs ? `?${qs}` : ''}`, {
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
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const reportCatalogApi = {
  catalog: () => apiRequest<ReportCatalogResponse>('/reports/catalog'),

  paymentHistory: (
    filters: DateRangeFilters & { customerId?: string; type?: 'PAYMENT' | 'ADJUSTMENT' },
    pagination?: PaginationParams,
  ) =>
    apiRequest<PaymentHistoryResult>('/reports/payment-history', {
      query: { ...filters, ...pagination },
    }),

  paymentHistoryExportCsv: (
    filters: DateRangeFilters & { customerId?: string; type?: 'PAYMENT' | 'ADJUSTMENT' },
  ) => downloadCsv('/reports/payment-history/export', filters, 'payment-history.csv'),

  revenueMargin: (
    groupBy: RevenueMarginGroupBy,
    filters: DateRangeFilters & { customerId?: string; carrierId?: string; equipmentType?: string },
    compare: boolean,
    pagination?: PaginationParams,
  ) =>
    apiRequest<RevenueMarginResult>('/reports/revenue-margin', {
      query: { groupBy, ...filters, compare: compare || undefined, ...pagination },
    }),

  revenueMarginExportCsv: (
    groupBy: RevenueMarginGroupBy,
    filters: DateRangeFilters & { customerId?: string; carrierId?: string; equipmentType?: string },
  ) => downloadCsv('/reports/revenue-margin/export', { groupBy, ...filters }, 'revenue-margin.csv'),

  loadVolume: (
    filters: DateRangeFilters & {
      bucket: LoadVolumeBucket;
      customerId?: string;
      equipmentType?: string;
    },
    pagination?: PaginationParams,
  ) =>
    apiRequest<PagedResult<LoadVolumeRow>>('/reports/load-volume', {
      query: { ...filters, ...pagination },
    }),

  loadVolumeExportCsv: (
    filters: DateRangeFilters & {
      bucket: LoadVolumeBucket;
      customerId?: string;
      equipmentType?: string;
    },
  ) => downloadCsv('/reports/load-volume/export', filters, 'load-volume.csv'),

  statusMix: (filters: { customerId?: string; carrierId?: string; equipmentType?: string }) =>
    apiRequest<StatusMixRow[]>('/reports/status-mix', { query: filters }),

  statusMixExportCsv: (filters: {
    customerId?: string;
    carrierId?: string;
    equipmentType?: string;
  }) => downloadCsv('/reports/status-mix/export', filters, 'status-mix.csv'),

  onTimePerformance: (
    groupBy: OnTimeGroupBy,
    filters: DateRangeFilters & { carrierId?: string; equipmentType?: string },
    pagination?: PaginationParams,
  ) =>
    apiRequest<PagedResult<OnTimeRow>>('/reports/on-time-performance', {
      query: { groupBy, ...filters, ...pagination },
    }),

  onTimePerformanceExportCsv: (
    groupBy: OnTimeGroupBy,
    filters: DateRangeFilters & { carrierId?: string; equipmentType?: string },
  ) =>
    downloadCsv(
      '/reports/on-time-performance/export',
      { groupBy, ...filters },
      'on-time-performance.csv',
    ),

  dispatcherWorkload: (filters: DateRangeFilters, pagination?: PaginationParams) =>
    apiRequest<PagedResult<DispatcherWorkloadRow>>('/reports/dispatcher-workload', {
      query: { ...filters, ...pagination },
    }),

  dispatcherWorkloadExportCsv: (filters: DateRangeFilters) =>
    downloadCsv('/reports/dispatcher-workload/export', filters, 'dispatcher-workload.csv'),

  carrierPerformance: (
    filters: DateRangeFilters & { equipmentType?: string },
    pagination?: PaginationParams,
  ) =>
    apiRequest<PagedResult<CarrierPerformanceRow>>('/reports/carrier-performance', {
      query: { ...filters, ...pagination },
    }),

  carrierPerformanceExportCsv: (filters: DateRangeFilters & { equipmentType?: string }) =>
    downloadCsv('/reports/carrier-performance/export', filters, 'carrier-performance.csv'),

  salesPerformance: (filters: DateRangeFilters, pagination?: PaginationParams) =>
    apiRequest<PagedResult<SalesPerformanceRow>>('/reports/sales-performance', {
      query: { ...filters, ...pagination },
    }),

  salesPerformanceExportCsv: (filters: DateRangeFilters) =>
    downloadCsv('/reports/sales-performance/export', filters, 'sales-performance.csv'),
};
