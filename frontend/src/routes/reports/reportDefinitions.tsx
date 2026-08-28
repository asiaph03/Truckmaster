import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { reportCatalogApi, type DateRangeFilters, type PagedResult } from '../../api';

/** Renders `—` for a redacted/absent value, never the literal string "null" — matches Document Center's own convention. */
export function moneyOrDash(value: string | null): ReactNode {
  return value === null ? '—' : `$${value}`;
}

export interface ReportColumn {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: Record<string, unknown>) => ReactNode;
}

export type ReportFilterState = DateRangeFilters & Record<string, string | undefined>;

export interface ReportFilterField {
  key: string;
  label: string;
  type: 'select' | 'date';
  options?: { value: string; label: string }[];
  /** Populates a select's options from live data (Customers/Carriers) rather than a static list. */
  optionsSource?: 'customers' | 'carriers';
  required?: boolean;
}

/**
 * Every `reportCatalogApi.X()` method returns a named row type
 * (`RevenueMarginRow`, `CarrierPerformanceRow`, ...) so its own API-client
 * signature stays precise; this page renders all of them through one
 * generic `DataTable`, so each `fetch` result is cast to this shared
 * shape at the boundary — `ReportColumn.render` already treats every row
 * generically via `Record<string, unknown>` regardless.
 */
export type ReportFetchResult = PagedResult<Record<string, unknown>> & {
  previousPeriod?: unknown;
  truncated?: boolean;
};

export interface ReportDefinition {
  id: string;
  title: string;
  basisNote: string;
  filterFields: ReportFilterField[];
  columns: ReportColumn[];
  rowKey: (row: Record<string, unknown>) => string;
  sortableKeys?: string[];
  supportsCompare?: boolean;
  paginated: boolean;
  fetch: (
    filters: ReportFilterState,
    pagination: { page: number; pageSize: number },
    compare: boolean,
  ) => Promise<ReportFetchResult>;
  exportCsv: (filters: ReportFilterState) => Promise<void>;
}

const GROUP_BY_OPTIONS = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'LANE', label: 'Lane' },
  { value: 'MONTH', label: 'Month' },
];

const ON_TIME_GROUP_BY_OPTIONS = [
  { value: 'CARRIER', label: 'Carrier' },
  { value: 'DISPATCHER', label: 'Dispatcher' },
];

const BUCKET_OPTIONS = [
  { value: 'DAY', label: 'Day' },
  { value: 'WEEK', label: 'Week' },
  { value: 'MONTH', label: 'Month' },
];

const PAYMENT_TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
];

/**
 * Phase 21 (Reports Library) — one entry per catalog report (§4 of the
 * approved plan), driving the single generic `ReportDetailPage`. Every
 * row that identifies a Customer/Carrier/Invoice links to its existing
 * detail route (approved "no drawers/modals" requirement) — Dispatcher/
 * Sales-Booking-created "rep" rows and Dispatcher-workload rows have no
 * detail page of their own anywhere else in the app, so those columns
 * render plain text, not an invented link target.
 */
export const REPORT_DEFINITIONS: Record<string, ReportDefinition> = {
  'payment-history': {
    id: 'payment-history',
    title: 'Payment History',
    basisNote: 'Every Payment and Adjustment in the selected date range — date range required.',
    filterFields: [
      { key: 'dateFrom', label: 'From', type: 'date', required: true },
      { key: 'dateTo', label: 'To', type: 'date', required: true },
      { key: 'customerId', label: 'Customer', type: 'select', optionsSource: 'customers' },
      { key: 'type', label: 'Type', type: 'select', options: PAYMENT_TYPE_OPTIONS },
    ],
    columns: [
      {
        key: 'date',
        header: 'Date',
        render: (r) => new Date(r.date as string).toLocaleDateString(),
      },
      { key: 'type', header: 'Type', render: (r) => r.type as ReactNode },
      {
        key: 'invoiceNumber',
        header: 'Invoice #',
        render: (r) => (
          <Link to={`/billing/invoices/${r.invoiceId}`}>{r.invoiceNumber as string}</Link>
        ),
      },
      {
        key: 'customerName',
        header: 'Customer',
        render: (r) => <Link to={`/customers/${r.customerId}`}>{r.customerName as string}</Link>,
      },
      { key: 'amount', header: 'Amount', numeric: true, render: (r) => `$${r.amount}` },
      { key: 'method', header: 'Method', render: (r) => (r.method as string) ?? '—' },
      { key: 'reason', header: 'Reason', render: (r) => (r.reason as string) ?? '—' },
      {
        key: 'recordedByName',
        header: 'Recorded By',
        render: (r) => r.recordedByName as ReactNode,
      },
    ],
    rowKey: (r) => r.id as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.paymentHistory(
        {
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          customerId: filters.customerId || undefined,
          type: (filters.type || undefined) as 'PAYMENT' | 'ADJUSTMENT' | undefined,
        },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.paymentHistoryExportCsv({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        customerId: filters.customerId || undefined,
        type: (filters.type || undefined) as 'PAYMENT' | 'ADJUSTMENT' | undefined,
      }),
  },

  'revenue-margin': {
    id: 'revenue-margin',
    title: 'Revenue & Margin',
    basisNote: 'Booked Date (Load.createdAt) — grouped by the selected dimension.',
    filterFields: [
      {
        key: 'groupBy',
        label: 'Group By',
        type: 'select',
        options: GROUP_BY_OPTIONS,
        required: true,
      },
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
      { key: 'customerId', label: 'Customer', type: 'select', optionsSource: 'customers' },
      { key: 'carrierId', label: 'Carrier', type: 'select', optionsSource: 'carriers' },
    ],
    columns: [
      { key: 'groupLabel', header: 'Group', render: (r) => r.groupLabel as ReactNode },
      {
        key: 'loadCount',
        header: 'Load Count',
        numeric: true,
        render: (r) => r.loadCount as ReactNode,
      },
      { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => `$${r.revenue}` },
      { key: 'cost', header: 'Cost', numeric: true, render: (r) => `$${r.cost}` },
      {
        key: 'grossProfit',
        header: 'Gross Profit',
        numeric: true,
        render: (r) => `$${r.grossProfit}`,
      },
      {
        key: 'marginPercent',
        header: 'Margin %',
        numeric: true,
        render: (r) => `${r.marginPercent}%`,
      },
    ],
    rowKey: (r) => r.groupKey as string,
    paginated: true,
    supportsCompare: true,
    fetch: (filters, pagination, compare) =>
      reportCatalogApi.revenueMargin(
        (filters.groupBy || 'CUSTOMER') as never,
        {
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          customerId: filters.customerId || undefined,
          carrierId: filters.carrierId || undefined,
        },
        compare,
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.revenueMarginExportCsv((filters.groupBy || 'CUSTOMER') as never, {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        customerId: filters.customerId || undefined,
        carrierId: filters.carrierId || undefined,
      }),
  },

  'load-volume': {
    id: 'load-volume',
    title: 'Load Volume',
    basisNote: 'Booked Date (Load.createdAt), bucketed by the selected period.',
    filterFields: [
      { key: 'bucket', label: 'Bucket', type: 'select', options: BUCKET_OPTIONS, required: true },
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
      { key: 'customerId', label: 'Customer', type: 'select', optionsSource: 'customers' },
    ],
    columns: [
      { key: 'period', header: 'Period', render: (r) => r.period as ReactNode },
      {
        key: 'loadCount',
        header: 'Load Count',
        numeric: true,
        render: (r) => r.loadCount as ReactNode,
      },
    ],
    rowKey: (r) => r.period as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.loadVolume(
        {
          bucket: (filters.bucket || 'MONTH') as never,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          customerId: filters.customerId || undefined,
        },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.loadVolumeExportCsv({
        bucket: (filters.bucket || 'MONTH') as never,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        customerId: filters.customerId || undefined,
      }),
  },

  'status-mix': {
    id: 'status-mix',
    title: 'Status Mix',
    basisNote: 'Current distribution of Loads by status — a snapshot, not date-ranged.',
    filterFields: [
      { key: 'customerId', label: 'Customer', type: 'select', optionsSource: 'customers' },
      { key: 'carrierId', label: 'Carrier', type: 'select', optionsSource: 'carriers' },
    ],
    columns: [
      { key: 'status', header: 'Status', render: (r) => r.status as ReactNode },
      { key: 'count', header: 'Count', numeric: true, render: (r) => r.count as ReactNode },
      {
        key: 'percentOfTotal',
        header: '% of Total',
        numeric: true,
        render: (r) => `${r.percentOfTotal}%`,
      },
    ],
    rowKey: (r) => r.status as string,
    paginated: false,
    fetch: async (filters) => {
      const items = await reportCatalogApi.statusMix({
        customerId: filters.customerId || undefined,
        carrierId: filters.carrierId || undefined,
      });
      return {
        items: items as unknown as Record<string, unknown>[],
        total: items.length,
        page: 1,
        pageSize: items.length,
      };
    },
    exportCsv: (filters) =>
      reportCatalogApi.statusMixExportCsv({
        customerId: filters.customerId || undefined,
        carrierId: filters.carrierId || undefined,
      }),
  },

  'on-time-performance': {
    id: 'on-time-performance',
    title: 'On-Time Performance',
    basisNote:
      'Delivery appointment window (Stop.appointmentDatetime). Deliveries with no scheduled appointment are excluded from the percentage and shown separately.',
    filterFields: [
      {
        key: 'groupBy',
        label: 'Group By',
        type: 'select',
        options: ON_TIME_GROUP_BY_OPTIONS,
        required: true,
      },
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
      { key: 'carrierId', label: 'Carrier', type: 'select', optionsSource: 'carriers' },
    ],
    columns: [
      { key: 'groupLabel', header: 'Group', render: (r) => r.groupLabel as ReactNode },
      {
        key: 'deliveriesEvaluated',
        header: 'Deliveries Evaluated',
        numeric: true,
        render: (r) => r.deliveriesEvaluated as ReactNode,
      },
      {
        key: 'onTimeCount',
        header: 'On-Time Count',
        numeric: true,
        render: (r) => r.onTimeCount as ReactNode,
      },
      {
        key: 'onTimePercent',
        header: 'On-Time %',
        numeric: true,
        render: (r) => `${r.onTimePercent}%`,
      },
      {
        key: 'excludedNoAppointment',
        header: 'Excluded (No Appointment)',
        numeric: true,
        render: (r) => r.excludedNoAppointment as ReactNode,
      },
    ],
    rowKey: (r) => r.groupKey as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.onTimePerformance(
        (filters.groupBy || 'CARRIER') as never,
        {
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          carrierId: filters.carrierId || undefined,
        },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.onTimePerformanceExportCsv((filters.groupBy || 'CARRIER') as never, {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        carrierId: filters.carrierId || undefined,
      }),
  },

  'dispatcher-workload': {
    id: 'dispatcher-workload',
    title: 'Dispatcher Workload',
    basisNote: 'Booked Date (Load.createdAt).',
    filterFields: [
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'dispatcherName', header: 'Dispatcher', render: (r) => r.dispatcherName as ReactNode },
      {
        key: 'loadsAssigned',
        header: 'Loads Assigned',
        numeric: true,
        render: (r) => r.loadsAssigned as ReactNode,
      },
      { key: 'active', header: 'Active', numeric: true, render: (r) => r.active as ReactNode },
      {
        key: 'deliveredOrClosed',
        header: 'Delivered/Closed',
        numeric: true,
        render: (r) => r.deliveredOrClosed as ReactNode,
      },
    ],
    rowKey: (r) => r.dispatcherId as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.dispatcherWorkload(
        { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.dispatcherWorkloadExportCsv({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
  },

  'carrier-performance': {
    id: 'carrier-performance',
    title: 'Carrier Performance',
    basisNote: 'Booked Date (Load.createdAt).',
    filterFields: [
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
    ],
    columns: [
      {
        key: 'carrierLegalName',
        header: 'Carrier',
        render: (r) => <Link to={`/carriers/${r.carrierId}`}>{r.carrierLegalName as string}</Link>,
      },
      {
        key: 'loadCount',
        header: 'Load Count',
        numeric: true,
        render: (r) => r.loadCount as ReactNode,
      },
      {
        key: 'rejectionRatePercent',
        header: 'Rejection Rate %',
        numeric: true,
        render: (r) => `${r.rejectionRatePercent}%`,
      },
      {
        key: 'onTimePercent',
        header: 'On-Time %',
        numeric: true,
        render: (r) => (r.onTimePercent ? `${r.onTimePercent}%` : '—'),
      },
      {
        key: 'totalCost',
        header: 'Total Cost',
        numeric: true,
        render: (r) => moneyOrDash(r.totalCost as string | null),
      },
      {
        key: 'avgCostPerLoad',
        header: 'Avg Cost/Load',
        numeric: true,
        render: (r) => moneyOrDash(r.avgCostPerLoad as string | null),
      },
    ],
    rowKey: (r) => r.carrierId as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.carrierPerformance(
        { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.carrierPerformanceExportCsv({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
  },

  'sales-performance': {
    id: 'sales-performance',
    title: 'Sales Performance by Rep',
    basisNote:
      'Quote metrics reflect quotes resolved in this period; Revenue/Gross Profit reflect loads booked in this period (Load.createdAt).',
    filterFields: [
      { key: 'dateFrom', label: 'From', type: 'date' },
      { key: 'dateTo', label: 'To', type: 'date' },
    ],
    columns: [
      { key: 'repName', header: 'Rep', render: (r) => r.repName as ReactNode },
      {
        key: 'quotesCreated',
        header: 'Quotes Created',
        numeric: true,
        render: (r) => r.quotesCreated as ReactNode,
      },
      { key: 'won', header: 'Won', numeric: true, render: (r) => r.won as ReactNode },
      { key: 'lost', header: 'Lost', numeric: true, render: (r) => r.lost as ReactNode },
      {
        key: 'winRatePercent',
        header: 'Win Rate %',
        numeric: true,
        render: (r) => `${r.winRatePercent}%`,
      },
      { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => `$${r.revenue}` },
      {
        key: 'grossProfit',
        header: 'Gross Profit',
        numeric: true,
        render: (r) => moneyOrDash(r.grossProfit as string | null),
      },
    ],
    rowKey: (r) => r.repUserId as string,
    paginated: true,
    fetch: (filters, pagination) =>
      reportCatalogApi.salesPerformance(
        { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
        pagination,
      ) as unknown as Promise<ReportFetchResult>,
    exportCsv: (filters) =>
      reportCatalogApi.salesPerformanceExportCsv({
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
  },
};
