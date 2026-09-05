import { Injectable } from '@nestjs/common';
import { MembershipRoleName, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';
import { ValidationError } from '../../../common/errors/app-error';
import { toCsv } from '../../quote-load/utils/csv';

type TenantTx = Prisma.TransactionClient;

/**
 * Phase 21 (Reports Library) role sets. Each is a small, single-purpose
 * local const — following the same convention as `INVOICE_VIEW_ROLES`
 * (reporting.service.ts) / `CARRIER_DOCUMENT_UPLOAD_ROLES`
 * (document.service.ts): a role list named after the exact locked-matrix
 * row it represents, not centralized, since none of the three is reused
 * outside this report-catalog. `FINANCIAL_VIEW_ROLES` (imported, unchanged)
 * continues to gate every Financial/AR-AP report, matching the locked
 * "Accounting = Financial reports" mapping exactly.
 */
export const OPERATIONS_REPORT_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
];

/** Approved decision — Carrier Performance adds Dispatcher/Accounting; cost columns still redact to Dispatcher via FINANCIAL_VIEW_ROLES. */
export const CARRIER_PERFORMANCE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'ACCOUNTING',
];

export const SALES_PERFORMANCE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'SALES_BOOKING',
];

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

export interface DateRangeFilters {
  dateFrom?: string;
  dateTo?: string;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

function parseDate(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function toMoney(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

function marginPercent(revenue: number, grossProfit: number): string {
  if (revenue === 0) return '0.00';
  return ((grossProfit / revenue) * 100).toFixed(2);
}

function paginate<T>(
  rows: T[],
  { page, pageSize }: PaginationParams,
): { items: T[]; total: number } {
  const total = rows.length;
  const start = (page - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), total };
}

// ---------------------------------------------------------------------
// Payment History
// ---------------------------------------------------------------------

export interface PaymentHistoryFilters extends DateRangeFilters {
  customerId?: string;
  type?: 'PAYMENT' | 'ADJUSTMENT';
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

export interface PaymentHistoryResult {
  items: PaymentHistoryRow[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
}

// Defensive cap only — not a business rule. Payment History requires a
// date range (see resolvePaymentHistoryRows), so this only bites on an
// unusually wide range; the API surfaces `truncated` rather than silently
// returning a wrong page.
const PAYMENT_HISTORY_SOURCE_CAP = 2000;

// ---------------------------------------------------------------------
// Revenue & Margin (also reused by Carrier Performance's cost columns
// and Sales Performance's revenue/GP columns — one engine, three callers)
// ---------------------------------------------------------------------

export type RevenueMarginGroupBy = 'CUSTOMER' | 'CARRIER' | 'LANE' | 'MONTH';
type RevenueRollupGroupBy = RevenueMarginGroupBy | 'SALES_USER';

const REVENUE_MARGIN_GROUP_BY_VALUES: RevenueMarginGroupBy[] = [
  'CUSTOMER',
  'CARRIER',
  'LANE',
  'MONTH',
];

export interface RevenueMarginFilters extends DateRangeFilters {
  customerId?: string;
  carrierId?: string;
  equipmentType?: string;
}

export interface RevenueMarginRow {
  groupKey: string;
  groupLabel: string;
  loadCount: number;
  revenue: string;
  cost: string;
  grossProfit: string;
  marginPercent: string;
}

export interface RevenueMarginResult {
  items: RevenueMarginRow[];
  total: number;
  page: number;
  pageSize: number;
  previousPeriod?: RevenueMarginRow[];
}

interface RevenueRollupRawRow {
  group_key: string | null;
  group_label: string | null;
  load_count: number | bigint;
  revenue: unknown;
  cost: unknown;
}

// ---------------------------------------------------------------------
// Load Volume
// ---------------------------------------------------------------------

export type LoadVolumeBucket = 'DAY' | 'WEEK' | 'MONTH';
const LOAD_VOLUME_BUCKET_VALUES: LoadVolumeBucket[] = ['DAY', 'WEEK', 'MONTH'];

export interface LoadVolumeFilters extends DateRangeFilters {
  bucket: LoadVolumeBucket;
  customerId?: string;
  equipmentType?: string;
}

export interface LoadVolumeRow {
  period: string;
  loadCount: number;
}

// ---------------------------------------------------------------------
// Status Mix
// ---------------------------------------------------------------------

export interface StatusMixFilters {
  customerId?: string;
  carrierId?: string;
  equipmentType?: string;
}

export interface StatusMixRow {
  status: string;
  count: number;
  percentOfTotal: string;
}

// ---------------------------------------------------------------------
// On-Time Performance (reused by Carrier Performance's on-time column)
// ---------------------------------------------------------------------

export type OnTimeGroupBy = 'CARRIER' | 'DISPATCHER';
const ON_TIME_GROUP_BY_VALUES: OnTimeGroupBy[] = ['CARRIER', 'DISPATCHER'];

export interface OnTimeFilters extends DateRangeFilters {
  equipmentType?: string;
  carrierId?: string;
}

export interface OnTimeRow {
  groupKey: string;
  groupLabel: string;
  deliveriesEvaluated: number;
  onTimeCount: number;
  onTimePercent: string;
  excludedNoAppointment: number;
}

interface OnTimeRawRow {
  group_key: string | null;
  group_label: string | null;
  deliveries_evaluated: number | bigint;
  on_time_count: number | bigint;
}

interface OnTimeExcludedRawRow {
  group_key: string | null;
  excluded_count: number | bigint;
}

// ---------------------------------------------------------------------
// Dispatcher Workload
// ---------------------------------------------------------------------

const ACTIVE_LOAD_STATUSES = [
  'BOOKED',
  'CARRIER_SOURCING',
  'CARRIER_ASSIGNED',
  'RATE_CONFIRMATION',
  'DISPATCHED',
  'PICKUP',
  'IN_TRANSIT',
] as const;
const COMPLETED_LOAD_STATUSES = ['DELIVERED', 'CLOSED'] as const;

/**
 * Cancel Load workflow — production hardening fix. `ACTIVE_LOAD_STATUSES`
 * union `COMPLETED_LOAD_STATUSES` is exactly "every LoadStatus except
 * CANCELLED" (9 of the 10 values), reused rather than duplicated so this
 * list can never drift from the two it's built from. Cancellation
 * deliberately never reverses a Load's existing ChargeLineItem rows (see
 * LoadService.cancelLoad's own doc comment — history is preserved, not
 * rewritten), so any revenue/cost/margin query that joins charge_line_item
 * to load must exclude CANCELLED explicitly or it will count a cancelled
 * load's pre-existing charges as real business. Used by `revenueRollup`
 * (Revenue & Margin, and — via that same engine — Carrier Performance's
 * cost columns and Sales Performance's revenue/GP columns) and by
 * `carrierPerformanceRows`'s own load-count query. Not used by
 * `onTimeRows` (provably unreachable by a CANCELLED load — see that
 * method's own doc comment), `statusMixRows` (CANCELLED is meant to show
 * there as its own bucket), or `paymentHistory` (Invoices, and therefore
 * Payments/Adjustments, can never exist against a CANCELLED load).
 */
const NON_CANCELLED_LOAD_STATUSES = [...ACTIVE_LOAD_STATUSES, ...COMPLETED_LOAD_STATUSES] as const;

export interface DispatcherWorkloadRow {
  dispatcherId: string;
  dispatcherName: string;
  loadsAssigned: number;
  active: number;
  deliveredOrClosed: number;
}

// ---------------------------------------------------------------------
// Carrier Performance
// ---------------------------------------------------------------------

export interface CarrierPerformanceFilters extends DateRangeFilters {
  equipmentType?: string;
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

// ---------------------------------------------------------------------
// Sales Performance by Rep
// ---------------------------------------------------------------------

export interface SalesPerformanceFilters extends DateRangeFilters {}

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

const QUOTE_WON_ACTION = 'Quote Won — Converted to Load';
const QUOTE_LOST_ACTIONS = ['Quote Marked Lost', 'Quote Expired — Automatically Marked Lost'];

/**
 * Phase 21 (Reports Library) — extends the existing, read-only,
 * cross-module ReportingModule (TECHNICAL_ARCHITECTURE.md §1.2's explicit
 * exception: reads directly across modules, owns no tables) with the 8 new
 * catalog reports approved in the Phase 21 plan, plus the role-aware
 * catalog listing. AR/AP Aging themselves are untouched — they stay on
 * `ReportingService`; this file only adds their `/export` CSV alongside
 * the 8 new reports.
 *
 * Every raw SQL query below runs via the `tx` client `withTenantTransaction`
 * hands in, so it inherits that transaction's `app.current_org_id` setting
 * (`PrismaService.withTenantTransaction`'s own doc-comment: `SET LOCAL` is
 * transaction-scoped) — RLS engages for raw queries exactly as it does for
 * ORM-built ones. Every query additionally carries an explicit
 * `organization_id = $1` predicate as defense-in-depth, matching the
 * two-layer pattern used everywhere else in this codebase. `groupBy`/
 * `bucket` values are validated against a fixed enum *before* selecting
 * which of several hardcoded SQL template strings to run — user input only
 * ever fills bound `$n` parameters, never SQL text.
 */
@Injectable()
export class ReportCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------------

  /**
   * Single source of truth for "which report categories does this role
   * see" — reuses the exact same role constants each report route guards
   * with. The frontend renders exactly what this returns, with zero
   * client-side role-to-category mapping, mirroring `ReportingService
   * .dashboard()`'s own established "no client-side role-to-section
   * mapping" convention instead of adding a new PermissionKey.
   */
  catalog(actingRoles: MembershipRoleName[]): { categories: ReportCatalogCategory[] } {
    const has = (roles: MembershipRoleName[]) => actingRoles.some((r) => roles.includes(r));

    const categories: (ReportCatalogCategory & { visible: boolean })[] = [
      {
        key: 'AR_AP',
        label: 'AR/AP',
        visible: has(FINANCIAL_VIEW_ROLES),
        reports: [
          { id: 'ar-aging', title: 'AR Aging', externalPath: '/billing/ar-aging' },
          { id: 'ap-aging', title: 'AP Aging', externalPath: '/billing/ap-aging' },
          { id: 'payment-history', title: 'Payment History' },
        ],
      },
      {
        key: 'FINANCIAL',
        label: 'Financial',
        visible: has(FINANCIAL_VIEW_ROLES),
        reports: [{ id: 'revenue-margin', title: 'Revenue & Margin' }],
      },
      {
        key: 'OPERATIONS',
        label: 'Operations',
        visible: has(OPERATIONS_REPORT_ROLES),
        reports: [
          { id: 'load-volume', title: 'Load Volume' },
          { id: 'status-mix', title: 'Status Mix' },
          { id: 'on-time-performance', title: 'On-Time Performance' },
          { id: 'dispatcher-workload', title: 'Dispatcher Workload' },
        ],
      },
      {
        key: 'CARRIER_PERFORMANCE',
        label: 'Carrier Performance',
        visible: has(CARRIER_PERFORMANCE_VIEW_ROLES),
        reports: [{ id: 'carrier-performance', title: 'Carrier Performance' }],
      },
      {
        key: 'SALES',
        label: 'Sales',
        visible: has(SALES_PERFORMANCE_VIEW_ROLES),
        reports: [{ id: 'sales-performance', title: 'Sales Performance by Rep' }],
      },
    ];

    return { categories: categories.filter((c) => c.visible).map(({ visible: _v, ...c }) => c) };
  }

  // ---------------------------------------------------------------------
  // Payment History
  // ---------------------------------------------------------------------

  async paymentHistory(
    organizationId: string,
    filters: PaymentHistoryFilters,
    pagination: PaginationParams,
  ): Promise<PaymentHistoryResult> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const { rows, truncated } = await this.resolvePaymentHistoryRows(tx, organizationId, filters);
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize, truncated };
    });
  }

  async paymentHistoryCsv(organizationId: string, filters: PaymentHistoryFilters): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const { rows } = await this.resolvePaymentHistoryRows(tx, organizationId, filters);
      const header = [
        'Date',
        'Type',
        'Invoice #',
        'Customer',
        'Amount',
        'Method',
        'Adjustment Type',
        'Reference #',
        'Reason',
        'Recorded By',
      ];
      const csvRows = rows.map((r) => [
        r.date,
        r.type,
        r.invoiceNumber,
        r.customerName,
        r.amount,
        r.method ?? '',
        r.adjustmentType ?? '',
        r.referenceNumber ?? '',
        r.reason ?? '',
        r.recordedByName,
      ]);
      return toCsv([header, ...csvRows]);
    });
  }

  /**
   * Date range is required (frontend defaults to the last 90 days) — a
   * merge-sort across two heterogeneous sources (Payment, Adjustment)
   * can't be paginated correctly at the SQL level per-source, so both
   * sources are fetched in full *within the required range* (capped
   * defensively at `PAYMENT_HISTORY_SOURCE_CAP` each — a safety net, not
   * a business rule) and merge-sorted here.
   */
  private async resolvePaymentHistoryRows(
    tx: TenantTx,
    organizationId: string,
    filters: PaymentHistoryFilters,
  ): Promise<{ rows: PaymentHistoryRow[]; truncated: boolean }> {
    if (!filters.dateFrom || !filters.dateTo) {
      throw new ValidationError('Payment History requires both dateFrom and dateTo.');
    }
    const dateFrom = parseDate(filters.dateFrom)!;
    const dateTo = parseDate(filters.dateTo)!;

    const includePayments = !filters.type || filters.type === 'PAYMENT';
    const includeAdjustments = !filters.type || filters.type === 'ADJUSTMENT';

    const [payments, adjustments] = await Promise.all([
      includePayments
        ? tx.payment.findMany({
            where: {
              organizationId,
              paymentDate: { gte: dateFrom, lte: dateTo },
              ...(filters.customerId ? { invoice: { customerId: filters.customerId } } : {}),
            },
            include: { invoice: { include: { customer: true } }, recordedBy: true },
            take: PAYMENT_HISTORY_SOURCE_CAP,
            orderBy: { paymentDate: 'desc' },
          })
        : [],
      includeAdjustments
        ? tx.adjustment.findMany({
            where: {
              organizationId,
              adjustmentDate: { gte: dateFrom, lte: dateTo },
              ...(filters.customerId ? { invoice: { customerId: filters.customerId } } : {}),
            },
            include: { invoice: { include: { customer: true } }, createdBy: true },
            take: PAYMENT_HISTORY_SOURCE_CAP,
            orderBy: { adjustmentDate: 'desc' },
          })
        : [],
    ]);

    const truncated =
      payments.length === PAYMENT_HISTORY_SOURCE_CAP ||
      adjustments.length === PAYMENT_HISTORY_SOURCE_CAP;

    const paymentRows: PaymentHistoryRow[] = payments.map((p) => ({
      id: p.id,
      type: 'PAYMENT',
      date: p.paymentDate.toISOString(),
      invoiceId: p.invoiceId,
      invoiceNumber: p.invoice.invoiceNumber,
      customerId: p.invoice.customerId,
      customerName: p.invoice.customer.legalName,
      amount: toMoney(p.amount),
      method: p.method,
      adjustmentType: null,
      referenceNumber: p.referenceNumber,
      reason: null,
      recordedByName: p.recordedBy.name,
    }));
    const adjustmentRows: PaymentHistoryRow[] = adjustments.map((a) => ({
      id: a.id,
      type: 'ADJUSTMENT',
      date: a.adjustmentDate.toISOString(),
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.invoiceNumber,
      customerId: a.invoice.customerId,
      customerName: a.invoice.customer.legalName,
      amount: toMoney(a.amount),
      method: null,
      adjustmentType: a.type,
      referenceNumber: null,
      reason: a.reason,
      recordedByName: a.createdBy.name,
    }));

    const rows = [...paymentRows, ...adjustmentRows].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    return { rows, truncated };
  }

  // ---------------------------------------------------------------------
  // Revenue & Margin
  // ---------------------------------------------------------------------

  async revenueMargin(
    organizationId: string,
    groupBy: string,
    filters: RevenueMarginFilters,
    pagination: PaginationParams,
    compare: boolean,
  ): Promise<RevenueMarginResult> {
    this.assertRevenueMarginGroupBy(groupBy);

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.revenueRollup(tx, organizationId, groupBy, filters);
      const { items, total } = paginate(rows, pagination);

      let previousPeriod: RevenueMarginRow[] | undefined;
      if (compare && filters.dateFrom && filters.dateTo) {
        const shifted = this.shiftDateRange(filters.dateFrom, filters.dateTo);
        const previousRows = await this.revenueRollup(tx, organizationId, groupBy, {
          ...filters,
          dateFrom: shifted.dateFrom,
          dateTo: shifted.dateTo,
        });
        previousPeriod = previousRows;
      }

      return { items, total, page: pagination.page, pageSize: pagination.pageSize, previousPeriod };
    });
  }

  async revenueMarginCsv(
    organizationId: string,
    groupBy: string,
    filters: RevenueMarginFilters,
  ): Promise<string> {
    this.assertRevenueMarginGroupBy(groupBy);

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.revenueRollup(tx, organizationId, groupBy, filters);
      const header = ['Group', 'Load Count', 'Revenue', 'Cost', 'Gross Profit', 'Margin %'];
      const csvRows = rows.map((r) => [
        r.groupLabel,
        String(r.loadCount),
        r.revenue,
        r.cost,
        r.grossProfit,
        r.marginPercent,
      ]);
      return toCsv([header, ...csvRows]);
    });
  }

  private assertRevenueMarginGroupBy(value: string): asserts value is RevenueMarginGroupBy {
    if (!REVENUE_MARGIN_GROUP_BY_VALUES.includes(value as RevenueMarginGroupBy)) {
      throw new ValidationError(
        `Invalid groupBy — expected one of ${REVENUE_MARGIN_GROUP_BY_VALUES.join(', ')}.`,
      );
    }
  }

  private shiftDateRange(dateFrom: string, dateTo: string): { dateFrom: string; dateTo: string } {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    const lengthMs = to.getTime() - from.getTime();
    const previousTo = new Date(from.getTime() - 24 * 60 * 60 * 1000);
    const previousFrom = new Date(previousTo.getTime() - lengthMs);
    return { dateFrom: previousFrom.toISOString(), dateTo: previousTo.toISOString() };
  }

  /**
   * DATABASE_DESIGN.md §20 — "Rollups (by customer/carrier/lane/
   * dispatcher/sales user/date/equipment) use SQL aggregation (GROUP BY)
   * directly over ChargeLineItem joined to Load." Prisma's `groupBy`
   * cannot express a join, so every dimension here is an isolated,
   * parameterized raw SQL query. `groupBy` was already validated by the
   * caller against a fixed enum — this switch only ever selects one of a
   * small number of hardcoded, complete query strings; no identifier is
   * ever built from a variable.
   *
   * Cancel Load workflow — production hardening fix. Every branch below
   * carries a literal `load.status IN (...)` clause matching
   * `NON_CANCELLED_LOAD_STATUSES` exactly (kept as plain SQL text, not a
   * bound parameter, since it's a fixed internal enum list rather than
   * caller input — same convention as this method's other literal
   * enum-value comparisons, e.g. `cli.side = 'CUSTOMER'` above). Without
   * it, a CANCELLED load's pre-existing ChargeLineItem rows — created
   * automatically at booking and at carrier assignment, and never
   * reversed by cancellation — would be counted as real revenue and cost.
   */
  private async revenueRollup(
    tx: TenantTx,
    organizationId: string,
    groupBy: RevenueRollupGroupBy,
    filters: RevenueMarginFilters,
  ): Promise<RevenueMarginRow[]> {
    const dateFrom = parseDate(filters.dateFrom) ?? null;
    const dateTo = parseDate(filters.dateTo) ?? null;
    const customerId = filters.customerId ?? null;
    const carrierId = filters.carrierId ?? null;
    const equipmentType = filters.equipmentType ?? null;

    let raw: RevenueRollupRawRow[];

    if (groupBy === 'CUSTOMER') {
      raw = await tx.$queryRaw<RevenueRollupRawRow[]>`
        SELECT load.customer_id::text AS group_key, customer.legal_name AS group_label,
          COUNT(DISTINCT load.id) AS load_count,
          COALESCE(SUM(CASE WHEN cli.side = 'CUSTOMER' THEN cli.amount END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN cli.side = 'CARRIER' THEN cli.amount END), 0) AS cost
        FROM load
        JOIN customer ON customer.id = load.customer_id
        LEFT JOIN charge_line_item cli ON cli.load_id = load.id
        WHERE load.organization_id = ${organizationId}::uuid
          AND load.status IN ('BOOKED','CARRIER_SOURCING','CARRIER_ASSIGNED','RATE_CONFIRMATION','DISPATCHED','PICKUP','IN_TRANSIT','DELIVERED','CLOSED')
          AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
          AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
          AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
          AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
          AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
        GROUP BY load.customer_id, customer.legal_name
      `;
    } else if (groupBy === 'CARRIER') {
      raw = await tx.$queryRaw<RevenueRollupRawRow[]>`
        SELECT load.assigned_carrier_id::text AS group_key, carrier.legal_name AS group_label,
          COUNT(DISTINCT load.id) AS load_count,
          COALESCE(SUM(CASE WHEN cli.side = 'CUSTOMER' THEN cli.amount END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN cli.side = 'CARRIER' THEN cli.amount END), 0) AS cost
        FROM load
        JOIN carrier ON carrier.id = load.assigned_carrier_id
        LEFT JOIN charge_line_item cli ON cli.load_id = load.id
        WHERE load.organization_id = ${organizationId}::uuid
          AND load.assigned_carrier_id IS NOT NULL
          AND load.status IN ('BOOKED','CARRIER_SOURCING','CARRIER_ASSIGNED','RATE_CONFIRMATION','DISPATCHED','PICKUP','IN_TRANSIT','DELIVERED','CLOSED')
          AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
          AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
          AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
          AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
          AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
        GROUP BY load.assigned_carrier_id, carrier.legal_name
      `;
    } else if (groupBy === 'MONTH') {
      raw = await tx.$queryRaw<RevenueRollupRawRow[]>`
        SELECT to_char(date_trunc('month', load.created_at), 'YYYY-MM') AS group_key,
          to_char(date_trunc('month', load.created_at), 'YYYY-MM') AS group_label,
          COUNT(DISTINCT load.id) AS load_count,
          COALESCE(SUM(CASE WHEN cli.side = 'CUSTOMER' THEN cli.amount END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN cli.side = 'CARRIER' THEN cli.amount END), 0) AS cost
        FROM load
        LEFT JOIN charge_line_item cli ON cli.load_id = load.id
        WHERE load.organization_id = ${organizationId}::uuid
          AND load.status IN ('BOOKED','CARRIER_SOURCING','CARRIER_ASSIGNED','RATE_CONFIRMATION','DISPATCHED','PICKUP','IN_TRANSIT','DELIVERED','CLOSED')
          AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
          AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
          AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
          AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
          AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
        GROUP BY 1
      `;
    } else if (groupBy === 'SALES_USER') {
      raw = await tx.$queryRaw<RevenueRollupRawRow[]>`
        SELECT load.created_by_user_id::text AS group_key, "user".name AS group_label,
          COUNT(DISTINCT load.id) AS load_count,
          COALESCE(SUM(CASE WHEN cli.side = 'CUSTOMER' THEN cli.amount END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN cli.side = 'CARRIER' THEN cli.amount END), 0) AS cost
        FROM load
        JOIN "user" ON "user".id = load.created_by_user_id
        LEFT JOIN charge_line_item cli ON cli.load_id = load.id
        WHERE load.organization_id = ${organizationId}::uuid
          AND load.status IN ('BOOKED','CARRIER_SOURCING','CARRIER_ASSIGNED','RATE_CONFIRMATION','DISPATCHED','PICKUP','IN_TRANSIT','DELIVERED','CLOSED')
          AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
          AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
          AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
          AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
          AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
        GROUP BY load.created_by_user_id, "user".name
      `;
    } else {
      // LANE — first PICKUP stop's city/state through last DELIVERY
      // stop's city/state, per load, then grouped on that derived pair.
      // Return Product feature — both subqueries add `stop_purpose =
      // 'STANDARD'`, so a return leg's own pickup/delivery never becomes
      // the reported lane.
      raw = await tx.$queryRaw<RevenueRollupRawRow[]>`
        WITH load_lane AS (
          SELECT load.id AS load_id,
            (SELECT s.city || ', ' || s.state FROM stop s
              WHERE s.load_id = load.id AND s.stop_type = 'PICKUP' AND s.stop_purpose = 'STANDARD'
              ORDER BY s.sequence ASC LIMIT 1) AS origin,
            (SELECT s.city || ', ' || s.state FROM stop s
              WHERE s.load_id = load.id AND s.stop_type = 'DELIVERY' AND s.stop_purpose = 'STANDARD'
              ORDER BY s.sequence DESC LIMIT 1) AS destination
          FROM load
          WHERE load.organization_id = ${organizationId}::uuid
            AND load.status IN ('BOOKED','CARRIER_SOURCING','CARRIER_ASSIGNED','RATE_CONFIRMATION','DISPATCHED','PICKUP','IN_TRANSIT','DELIVERED','CLOSED')
            AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
            AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
            AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
            AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
            AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
        )
        SELECT (load_lane.origin || ' -> ' || load_lane.destination) AS group_key,
          (load_lane.origin || ' -> ' || load_lane.destination) AS group_label,
          COUNT(DISTINCT load_lane.load_id) AS load_count,
          COALESCE(SUM(CASE WHEN cli.side = 'CUSTOMER' THEN cli.amount END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN cli.side = 'CARRIER' THEN cli.amount END), 0) AS cost
        FROM load_lane
        LEFT JOIN charge_line_item cli ON cli.load_id = load_lane.load_id
        WHERE load_lane.origin IS NOT NULL AND load_lane.destination IS NOT NULL
        GROUP BY load_lane.origin, load_lane.destination
      `;
    }

    return raw
      .filter((r) => r.group_key !== null)
      .map((r) => {
        const revenue = Number(r.revenue ?? 0);
        const cost = Number(r.cost ?? 0);
        const grossProfit = revenue - cost;
        return {
          groupKey: r.group_key as string,
          groupLabel: r.group_label ?? (r.group_key as string),
          loadCount: Number(r.load_count),
          revenue: toMoney(revenue),
          cost: toMoney(cost),
          grossProfit: toMoney(grossProfit),
          marginPercent: marginPercent(revenue, grossProfit),
        };
      });
  }

  // ---------------------------------------------------------------------
  // Load Volume
  // ---------------------------------------------------------------------

  async loadVolume(
    organizationId: string,
    filters: LoadVolumeFilters,
    pagination: PaginationParams,
  ): Promise<{ items: LoadVolumeRow[]; total: number; page: number; pageSize: number }> {
    this.assertLoadVolumeBucket(filters.bucket);
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.loadVolumeRows(tx, organizationId, filters);
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async loadVolumeCsv(organizationId: string, filters: LoadVolumeFilters): Promise<string> {
    this.assertLoadVolumeBucket(filters.bucket);
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.loadVolumeRows(tx, organizationId, filters);
      const header = ['Period', 'Load Count'];
      return toCsv([header, ...rows.map((r) => [r.period, String(r.loadCount)])]);
    });
  }

  private assertLoadVolumeBucket(value: string): asserts value is LoadVolumeBucket {
    if (!LOAD_VOLUME_BUCKET_VALUES.includes(value as LoadVolumeBucket)) {
      throw new ValidationError(
        `Invalid bucket — expected one of ${LOAD_VOLUME_BUCKET_VALUES.join(', ')}.`,
      );
    }
  }

  private async loadVolumeRows(
    tx: TenantTx,
    organizationId: string,
    filters: LoadVolumeFilters,
  ): Promise<LoadVolumeRow[]> {
    const dateFrom = parseDate(filters.dateFrom) ?? null;
    const dateTo = parseDate(filters.dateTo) ?? null;
    const customerId = filters.customerId ?? null;
    const equipmentType = filters.equipmentType ?? null;
    const truncUnit =
      filters.bucket === 'DAY' ? 'day' : filters.bucket === 'WEEK' ? 'week' : 'month';
    const dateFormat = filters.bucket === 'MONTH' ? 'YYYY-MM' : 'YYYY-MM-DD';

    const raw = await tx.$queryRaw<{ period: string; load_count: number | bigint }[]>`
      SELECT to_char(date_trunc(${truncUnit}, load.created_at), ${dateFormat}) AS period,
        COUNT(*) AS load_count
      FROM load
      WHERE load.organization_id = ${organizationId}::uuid
        AND (${dateFrom}::timestamp IS NULL OR load.created_at >= ${dateFrom}::timestamp)
        AND (${dateTo}::timestamp IS NULL OR load.created_at <= ${dateTo}::timestamp)
        AND (${customerId}::uuid IS NULL OR load.customer_id = ${customerId}::uuid)
        AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return raw.map((r) => ({ period: r.period, loadCount: Number(r.load_count) }));
  }

  // ---------------------------------------------------------------------
  // Status Mix
  // ---------------------------------------------------------------------

  async statusMix(organizationId: string, filters: StatusMixFilters): Promise<StatusMixRow[]> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.statusMixRows(tx, organizationId, filters),
    );
  }

  async statusMixCsv(organizationId: string, filters: StatusMixFilters): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.statusMixRows(tx, organizationId, filters);
      const header = ['Status', 'Count', '% of Total'];
      return toCsv([header, ...rows.map((r) => [r.status, String(r.count), r.percentOfTotal])]);
    });
  }

  private async statusMixRows(
    tx: TenantTx,
    organizationId: string,
    filters: StatusMixFilters,
  ): Promise<StatusMixRow[]> {
    const grouped = await tx.load.groupBy({
      by: ['status'],
      where: {
        organizationId,
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.carrierId ? { assignedCarrierId: filters.carrierId } : {}),
        ...(filters.equipmentType ? { equipmentType: filters.equipmentType as never } : {}),
      },
      _count: true,
    });

    const total = grouped.reduce((sum, g) => sum + g._count, 0);
    return grouped
      .map((g) => ({
        status: g.status,
        count: g._count,
        percentOfTotal: total === 0 ? '0.00' : ((g._count / total) * 100).toFixed(2),
      }))
      .sort((a, b) => b.count - a.count);
  }

  // ---------------------------------------------------------------------
  // On-Time Performance
  // ---------------------------------------------------------------------

  async onTimePerformance(
    organizationId: string,
    groupBy: string,
    filters: OnTimeFilters,
    pagination: PaginationParams,
  ): Promise<{ items: OnTimeRow[]; total: number; page: number; pageSize: number }> {
    this.assertOnTimeGroupBy(groupBy);
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.onTimeRows(tx, organizationId, groupBy, filters);
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async onTimePerformanceCsv(
    organizationId: string,
    groupBy: string,
    filters: OnTimeFilters,
  ): Promise<string> {
    this.assertOnTimeGroupBy(groupBy);
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.onTimeRows(tx, organizationId, groupBy, filters);
      const header = [
        'Group',
        'Deliveries Evaluated',
        'On-Time Count',
        'On-Time %',
        'Excluded (No Appointment)',
      ];
      return toCsv([
        header,
        ...rows.map((r) => [
          r.groupLabel,
          String(r.deliveriesEvaluated),
          String(r.onTimeCount),
          r.onTimePercent,
          String(r.excludedNoAppointment),
        ]),
      ]);
    });
  }

  private assertOnTimeGroupBy(value: string): asserts value is OnTimeGroupBy {
    if (!ON_TIME_GROUP_BY_VALUES.includes(value as OnTimeGroupBy)) {
      throw new ValidationError(
        `Invalid groupBy — expected one of ${ON_TIME_GROUP_BY_VALUES.join(', ')}.`,
      );
    }
  }

  /**
   * On-time = `Stop.actualArrival <= Stop.appointmentDatetime` for
   * DELIVERY stops with both fields set. Stops with a null
   * `appointmentDatetime` are excluded from the evaluated denominator and
   * reported separately (`excludedNoAppointment`) rather than silently
   * dropped — approved decision.
   *
   * Return Product feature — every query below adds `stop_purpose =
   * 'STANDARD'`, so a return delivery never appears in either the
   * evaluated or excluded on-time counts.
   */
  private async onTimeRows(
    tx: TenantTx,
    organizationId: string,
    groupBy: OnTimeGroupBy,
    filters: OnTimeFilters,
  ): Promise<OnTimeRow[]> {
    const dateFrom = parseDate(filters.dateFrom) ?? null;
    const dateTo = parseDate(filters.dateTo) ?? null;
    const carrierId = filters.carrierId ?? null;
    const equipmentType = filters.equipmentType ?? null;

    const [evaluated, excluded] =
      groupBy === 'CARRIER'
        ? await Promise.all([
            tx.$queryRaw<OnTimeRawRow[]>`
              SELECT load.assigned_carrier_id::text AS group_key, carrier.legal_name AS group_label,
                COUNT(*) AS deliveries_evaluated,
                COUNT(*) FILTER (WHERE stop.actual_arrival <= stop.appointment_datetime) AS on_time_count
              FROM stop
              JOIN load ON load.id = stop.load_id
              JOIN carrier ON carrier.id = load.assigned_carrier_id
              WHERE stop.stop_type = 'DELIVERY'
                AND stop.stop_purpose = 'STANDARD'
                AND stop.appointment_datetime IS NOT NULL
                AND stop.actual_arrival IS NOT NULL
                AND load.organization_id = ${organizationId}::uuid
                AND load.assigned_carrier_id IS NOT NULL
                AND (${dateFrom}::timestamp IS NULL OR stop.appointment_datetime >= ${dateFrom}::timestamp)
                AND (${dateTo}::timestamp IS NULL OR stop.appointment_datetime <= ${dateTo}::timestamp)
                AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
                AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
              GROUP BY load.assigned_carrier_id, carrier.legal_name
            `,
            tx.$queryRaw<OnTimeExcludedRawRow[]>`
              SELECT load.assigned_carrier_id::text AS group_key, COUNT(*) AS excluded_count
              FROM stop
              JOIN load ON load.id = stop.load_id
              WHERE stop.stop_type = 'DELIVERY'
                AND stop.stop_purpose = 'STANDARD'
                AND stop.appointment_datetime IS NULL
                AND stop.actual_arrival IS NOT NULL
                AND load.organization_id = ${organizationId}::uuid
                AND load.assigned_carrier_id IS NOT NULL
                AND (${carrierId}::uuid IS NULL OR load.assigned_carrier_id = ${carrierId}::uuid)
                AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
              GROUP BY load.assigned_carrier_id
            `,
          ])
        : await Promise.all([
            tx.$queryRaw<OnTimeRawRow[]>`
              SELECT load.assigned_dispatcher_id::text AS group_key, "user".name AS group_label,
                COUNT(*) AS deliveries_evaluated,
                COUNT(*) FILTER (WHERE stop.actual_arrival <= stop.appointment_datetime) AS on_time_count
              FROM stop
              JOIN load ON load.id = stop.load_id
              JOIN "user" ON "user".id = load.assigned_dispatcher_id
              WHERE stop.stop_type = 'DELIVERY'
                AND stop.stop_purpose = 'STANDARD'
                AND stop.appointment_datetime IS NOT NULL
                AND stop.actual_arrival IS NOT NULL
                AND load.organization_id = ${organizationId}::uuid
                AND load.assigned_dispatcher_id IS NOT NULL
                AND (${dateFrom}::timestamp IS NULL OR stop.appointment_datetime >= ${dateFrom}::timestamp)
                AND (${dateTo}::timestamp IS NULL OR stop.appointment_datetime <= ${dateTo}::timestamp)
                AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
              GROUP BY load.assigned_dispatcher_id, "user".name
            `,
            tx.$queryRaw<OnTimeExcludedRawRow[]>`
              SELECT load.assigned_dispatcher_id::text AS group_key, COUNT(*) AS excluded_count
              FROM stop
              JOIN load ON load.id = stop.load_id
              WHERE stop.stop_type = 'DELIVERY'
                AND stop.stop_purpose = 'STANDARD'
                AND stop.appointment_datetime IS NULL
                AND stop.actual_arrival IS NOT NULL
                AND load.organization_id = ${organizationId}::uuid
                AND load.assigned_dispatcher_id IS NOT NULL
                AND (${equipmentType}::"EquipmentType" IS NULL OR load.equipment_type = ${equipmentType}::"EquipmentType")
              GROUP BY load.assigned_dispatcher_id
            `,
          ]);

    const excludedByKey = new Map(excluded.map((e) => [e.group_key, Number(e.excluded_count)]));

    return evaluated
      .filter((r) => r.group_key !== null)
      .map((r) => {
        const deliveriesEvaluated = Number(r.deliveries_evaluated);
        const onTimeCount = Number(r.on_time_count);
        return {
          groupKey: r.group_key as string,
          groupLabel: r.group_label ?? (r.group_key as string),
          deliveriesEvaluated,
          onTimeCount,
          onTimePercent:
            deliveriesEvaluated === 0
              ? '0.00'
              : ((onTimeCount / deliveriesEvaluated) * 100).toFixed(2),
          excludedNoAppointment: excludedByKey.get(r.group_key) ?? 0,
        };
      });
  }

  // ---------------------------------------------------------------------
  // Dispatcher Workload
  // ---------------------------------------------------------------------

  async dispatcherWorkload(
    organizationId: string,
    filters: DateRangeFilters,
    pagination: PaginationParams,
  ): Promise<{ items: DispatcherWorkloadRow[]; total: number; page: number; pageSize: number }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.dispatcherWorkloadRows(tx, organizationId, filters);
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async dispatcherWorkloadCsv(organizationId: string, filters: DateRangeFilters): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.dispatcherWorkloadRows(tx, organizationId, filters);
      const header = ['Dispatcher', 'Loads Assigned', 'Active', 'Delivered/Closed'];
      return toCsv([
        header,
        ...rows.map((r) => [
          r.dispatcherName,
          String(r.loadsAssigned),
          String(r.active),
          String(r.deliveredOrClosed),
        ]),
      ]);
    });
  }

  private async dispatcherWorkloadRows(
    tx: TenantTx,
    organizationId: string,
    filters: DateRangeFilters,
  ): Promise<DispatcherWorkloadRow[]> {
    const dateFilter = {
      ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
    };
    const where = {
      organizationId,
      assignedDispatcherId: { not: null },
      ...(filters.dateFrom || filters.dateTo ? { createdAt: dateFilter } : {}),
    };

    const [total, active, completed] = await Promise.all([
      tx.load.groupBy({ by: ['assignedDispatcherId'], where, _count: true }),
      tx.load.groupBy({
        by: ['assignedDispatcherId'],
        where: { ...where, status: { in: [...ACTIVE_LOAD_STATUSES] } },
        _count: true,
      }),
      tx.load.groupBy({
        by: ['assignedDispatcherId'],
        where: { ...where, status: { in: [...COMPLETED_LOAD_STATUSES] } },
        _count: true,
      }),
    ]);

    const activeByDispatcher = new Map(total.map((t) => [t.assignedDispatcherId as string, 0]));
    active.forEach((a) => activeByDispatcher.set(a.assignedDispatcherId as string, a._count));
    const completedByDispatcher = new Map(total.map((t) => [t.assignedDispatcherId as string, 0]));
    completed.forEach((c) => completedByDispatcher.set(c.assignedDispatcherId as string, c._count));

    const dispatcherIds = total.map((t) => t.assignedDispatcherId as string);
    const users = dispatcherIds.length
      ? await tx.user.findMany({
          where: { id: { in: dispatcherIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return total.map((t) => {
      const dispatcherId = t.assignedDispatcherId as string;
      return {
        dispatcherId,
        dispatcherName: nameById.get(dispatcherId) ?? dispatcherId,
        loadsAssigned: t._count,
        active: activeByDispatcher.get(dispatcherId) ?? 0,
        deliveredOrClosed: completedByDispatcher.get(dispatcherId) ?? 0,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Carrier Performance
  // ---------------------------------------------------------------------

  /**
   * Composed from three already-defined engines — sourcing-attempt
   * rejection rate (direct Prisma `groupBy`, no join needed), the
   * On-Time Performance report's CARRIER-grouped helper, and the Revenue
   * & Margin report's CARRIER-grouped helper (cost half only) — merged
   * by carrierId, not a fourth separate implementation.
   */
  async carrierPerformance(
    organizationId: string,
    actingRoles: MembershipRoleName[],
    filters: CarrierPerformanceFilters,
    pagination: PaginationParams,
  ): Promise<{ items: CarrierPerformanceRow[]; total: number; page: number; pageSize: number }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.carrierPerformanceRows(tx, organizationId, actingRoles, filters);
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async carrierPerformanceCsv(
    organizationId: string,
    actingRoles: MembershipRoleName[],
    filters: CarrierPerformanceFilters,
  ): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.carrierPerformanceRows(tx, organizationId, actingRoles, filters);
      const header = [
        'Carrier',
        'Load Count',
        'Rejection Rate %',
        'On-Time %',
        'Total Cost',
        'Avg Cost/Load',
      ];
      return toCsv([
        header,
        ...rows.map((r) => [
          r.carrierLegalName,
          String(r.loadCount),
          r.rejectionRatePercent,
          r.onTimePercent ?? '',
          r.totalCost ?? '',
          r.avgCostPerLoad ?? '',
        ]),
      ]);
    });
  }

  private async carrierPerformanceRows(
    tx: TenantTx,
    organizationId: string,
    actingRoles: MembershipRoleName[],
    filters: CarrierPerformanceFilters,
  ): Promise<CarrierPerformanceRow[]> {
    const showCost = actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r));
    const dateFilter = {
      ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
    };
    const loadFilter = {
      ...(filters.dateFrom || filters.dateTo ? { createdAt: dateFilter } : {}),
      ...(filters.equipmentType ? { equipmentType: filters.equipmentType as never } : {}),
    };

    const [loadCounts, sourcingAttempts, onTimeRows, costRows] = await Promise.all([
      // Cancel Load workflow — production hardening fix. `loadCount` is the
      // denominator of `avgCostPerLoad` below, so a CANCELLED load (which
      // can still carry an assignedCarrierId + a preserved carrier-side
      // ChargeLineItem from before it was cancelled) must not count here,
      // or it inflates the count without contributing real freight moved.
      // `sourcingAttempts` (rejection rate) is deliberately left unfiltered
      // — it measures carrier sourcing behavior, not revenue/cost, and a
      // decline/rejection is a fact about the carrier regardless of the
      // load's later fate.
      tx.load.groupBy({
        by: ['assignedCarrierId'],
        where: {
          organizationId,
          assignedCarrierId: { not: null },
          status: { in: [...NON_CANCELLED_LOAD_STATUSES] },
          ...loadFilter,
        },
        _count: true,
      }),
      tx.carrierSourcingAttempt.groupBy({
        by: ['carrierId', 'outcome'],
        where: { organizationId, load: loadFilter },
        _count: true,
      }),
      this.onTimeRows(tx, organizationId, 'CARRIER', filters),
      this.revenueRollup(tx, organizationId, 'CARRIER', filters),
    ]);

    const carrierIds = new Set<string>([
      ...loadCounts.map((l) => l.assignedCarrierId as string),
      ...sourcingAttempts.map((s) => s.carrierId),
    ]);
    const carriers = carrierIds.size
      ? await tx.carrier.findMany({
          where: { id: { in: [...carrierIds] }, organizationId },
          select: { id: true, legalName: true },
        })
      : [];
    const nameById = new Map(carriers.map((c) => [c.id, c.legalName]));

    const loadCountById = new Map(loadCounts.map((l) => [l.assignedCarrierId as string, l._count]));
    const onTimeById = new Map(onTimeRows.map((r) => [r.groupKey, r]));
    const costById = new Map(costRows.map((r) => [r.groupKey, r]));

    const rejectionById = new Map<string, { total: number; rejected: number }>();
    for (const attempt of sourcingAttempts) {
      const existing = rejectionById.get(attempt.carrierId) ?? { total: 0, rejected: 0 };
      existing.total += attempt._count;
      if (attempt.outcome === 'DECLINED' || attempt.outcome === 'REJECTED_AFTER_ASSIGNMENT') {
        existing.rejected += attempt._count;
      }
      rejectionById.set(attempt.carrierId, existing);
    }

    return [...carrierIds].map((carrierId) => {
      const rejection = rejectionById.get(carrierId);
      const onTime = onTimeById.get(carrierId);
      const cost = costById.get(carrierId);
      const loadCount = loadCountById.get(carrierId) ?? 0;
      const totalCost = cost ? Number(cost.cost) : 0;

      return {
        carrierId,
        carrierLegalName: nameById.get(carrierId) ?? carrierId,
        loadCount,
        rejectionRatePercent:
          !rejection || rejection.total === 0
            ? '0.00'
            : ((rejection.rejected / rejection.total) * 100).toFixed(2),
        onTimePercent: onTime?.onTimePercent ?? null,
        totalCost: showCost ? toMoney(totalCost) : null,
        avgCostPerLoad: showCost ? toMoney(loadCount === 0 ? 0 : totalCost / loadCount) : null,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Sales Performance by Rep
  // ---------------------------------------------------------------------

  async salesPerformance(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: SalesPerformanceFilters,
    pagination: PaginationParams,
  ): Promise<{ items: SalesPerformanceRow[]; total: number; page: number; pageSize: number }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.salesPerformanceRows(
        tx,
        organizationId,
        actingUserId,
        actingRoles,
        filters,
      );
      const { items, total } = paginate(rows, pagination);
      return { items, total, page: pagination.page, pageSize: pagination.pageSize };
    });
  }

  async salesPerformanceCsv(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: SalesPerformanceFilters,
  ): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const rows = await this.salesPerformanceRows(
        tx,
        organizationId,
        actingUserId,
        actingRoles,
        filters,
      );
      const header = [
        'Rep',
        'Quotes Created',
        'Won',
        'Lost',
        'Win Rate %',
        'Revenue',
        'Gross Profit',
      ];
      return toCsv([
        header,
        ...rows.map((r) => [
          r.repName,
          String(r.quotesCreated),
          String(r.won),
          String(r.lost),
          r.winRatePercent,
          r.revenue,
          r.grossProfit ?? '',
        ]),
      ]);
    });
  }

  /**
   * Quote metrics are ranged by the quote's resolution-event date
   * (mirrors `ReportingService.salesBlock`'s existing pattern, generalized
   * from "last 30 days, caller only" to an arbitrary range and every
   * rep); Revenue/GP are ranged by `Load.createdAt` per the approved
   * date-basis decision — a deliberate, UI-labeled distinction, not a
   * silent conflation (see reportDefinitions.ts on the frontend).
   *
   * Sales/Booking is scoped to their own row only, and their own
   * `grossProfit` is nulled even on that row — reusing the already-locked
   * "Sales sees revenue only, never margin/carrier cost, regardless of
   * ownership" rule (financial-field-shaping.ts's own documented reason
   * for omitting `viewLoadFinancials` from Sales/Booking's permission
   * set): showing GP alongside Revenue would let Carrier Cost be derived
   * by subtraction.
   */
  private async salesPerformanceRows(
    tx: TenantTx,
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: SalesPerformanceFilters,
  ): Promise<SalesPerformanceRow[]> {
    const fullVisibility = actingRoles.some((r) => r === 'ADMIN' || r === 'OPERATIONS_MANAGER');
    const dateFilter = {
      ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {}),
    };

    const [quotesCreated, resolutionEvents, revenueRows] = await Promise.all([
      tx.quote.groupBy({
        by: ['createdByUserId'],
        where: {
          organizationId,
          ...(filters.dateFrom || filters.dateTo ? { createdAt: dateFilter } : {}),
        },
        _count: true,
      }),
      tx.auditLog.findMany({
        where: {
          organizationId,
          entityType: 'Quote',
          action: { in: [QUOTE_WON_ACTION, ...QUOTE_LOST_ACTIONS] },
          ...(filters.dateFrom || filters.dateTo ? { createdAt: dateFilter } : {}),
        },
        select: { entityId: true, action: true },
      }),
      this.revenueRollup(tx, organizationId, 'SALES_USER', {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
    ]);

    const quoteIds = [...new Set(resolutionEvents.map((e) => e.entityId))];
    const quotes = quoteIds.length
      ? await tx.quote.findMany({
          where: { organizationId, id: { in: quoteIds } },
          select: { id: true, createdByUserId: true },
        })
      : [];
    const repByQuoteId = new Map(quotes.map((q) => [q.id, q.createdByUserId]));

    const wonByRep = new Map<string, number>();
    const lostByRep = new Map<string, number>();
    for (const event of resolutionEvents) {
      const repId = repByQuoteId.get(event.entityId);
      if (!repId) continue;
      if (event.action === QUOTE_WON_ACTION) {
        wonByRep.set(repId, (wonByRep.get(repId) ?? 0) + 1);
      } else {
        lostByRep.set(repId, (lostByRep.get(repId) ?? 0) + 1);
      }
    }

    const revenueByRep = new Map(revenueRows.map((r) => [r.groupKey, r]));
    const repIds = new Set<string>([
      ...quotesCreated.map((q) => q.createdByUserId),
      ...wonByRep.keys(),
      ...lostByRep.keys(),
      ...revenueRows.map((r) => r.groupKey),
    ]);

    const users = repIds.size
      ? await tx.user.findMany({
          where: { id: { in: [...repIds] } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    let rows: SalesPerformanceRow[] = [...repIds].map((repUserId) => {
      const won = wonByRep.get(repUserId) ?? 0;
      const lost = lostByRep.get(repUserId) ?? 0;
      const revenueRow = revenueByRep.get(repUserId);
      return {
        repUserId,
        repName: nameById.get(repUserId) ?? repUserId,
        quotesCreated: quotesCreated.find((q) => q.createdByUserId === repUserId)?._count ?? 0,
        won,
        lost,
        winRatePercent: won + lost === 0 ? '0.00' : ((won / (won + lost)) * 100).toFixed(2),
        revenue: revenueRow?.revenue ?? '0.00',
        grossProfit: revenueRow?.grossProfit ?? '0.00',
      };
    });

    if (!fullVisibility && actingRoles.includes('SALES_BOOKING')) {
      rows = rows
        .filter((r) => r.repUserId === actingUserId)
        .map((r) => ({ ...r, grossProfit: null }));
    }

    return rows;
  }
}
