import { Injectable } from '@nestjs/common';
import {
  AttentionSeverity,
  AttentionStatus,
  MembershipRoleName,
  Notification,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shapeFinancialFieldsList } from '../../quote-load/services/financial-field-shaping';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';
import { toCsv } from '../../quote-load/utils/csv';

const SEARCH_RESULT_LIMIT = 5;

/**
 * B.5 — Needs Attention combined source list. Both `Notification` and
 * `AttentionItem` are fetched up to this cap, combined, sorted, then
 * paginated in application code (see `needsAttention` below) — there is
 * no single-query way to sort/paginate across two different Prisma
 * models without raw SQL. 500 is a deliberate, generous safety ceiling
 * given current org-scale volumes (low tens at most); it is not a
 * literal "no limit," and should be revisited if any org's active
 * unread-notification-or-active-AttentionItem count approaches it.
 */
const NEEDS_ATTENTION_SOURCE_FETCH_CAP = 500;

const NEEDS_ATTENTION_NOTIFICATION_TYPES = [
  'CHECK_CALL_OVERDUE',
  'LOAD_LATE',
  'CHECK_CALL_DUE_SOON',
] as const;
type NeedsAttentionNotificationType = (typeof NEEDS_ATTENTION_NOTIFICATION_TYPES)[number];

/**
 * B.5 — `Notification` has no severity field; this is the explicit,
 * documented mapping onto `AttentionSeverity` so legacy signals sort
 * sensibly alongside real AttentionItems, rather than an arbitrary
 * default. Reasoning:
 *  - CHECK_CALL_OVERDUE: an already-overdue condition — comparable
 *    urgency to STALE_LOCATION's own HIGH tier.
 *  - LOAD_LATE: an already-late Load with direct customer/financial
 *    consequence — at least as urgent as an overdue check call.
 *  - CHECK_CALL_DUE_SOON: a pre-emptive warning fired *before* the Load
 *    actually becomes overdue (Operational Alerts feature, within 15
 *    minutes of crossing the threshold) — a real but lesser concern,
 *    mirroring the MEDIUM tier's "warning, not yet urgent" meaning
 *    elsewhere in this codebase.
 * None maps to CRITICAL — no existing Notification type represents a
 * condition this codebase treats as more urgent than "already overdue."
 */
const NOTIFICATION_SEVERITY: Record<NeedsAttentionNotificationType, AttentionSeverity> = {
  CHECK_CALL_OVERDUE: 'HIGH',
  LOAD_LATE: 'HIGH',
  CHECK_CALL_DUE_SOON: 'MEDIUM',
};

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  INFO: 1,
};

/**
 * B.5 — normalized shape for both sources. Fields with no equivalent in
 * the source row are `null` rather than invented (e.g. a Notification
 * has no `title`/`reason`/`impact`; an AttentionItem has no `message`).
 */
export interface NeedsAttentionItem {
  id: string;
  source: 'NOTIFICATION' | 'ATTENTION_ITEM';
  type: string;
  severity: AttentionSeverity;
  status: AttentionStatus | null;
  title: string | null;
  message: string | null;
  reason: string | null;
  impact: string | null;
  suggestedActions: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  loadId: string;
  loadNumber: string;
  createdAt: Date | null;
  detectedAt: Date | null;
  updatedAt: Date | null;
  resolvedAt: Date | null;
}

export interface NeedsAttentionResult {
  items: NeedsAttentionItem[];
  total: number;
  page: number;
  pageSize: number;
}

function needsAttentionTimestamp(item: NeedsAttentionItem): number {
  return (item.detectedAt ?? item.createdAt)!.getTime();
}

/** Severity descending, then most-recent first, then `id` as a deterministic final tie-breaker. */
function compareNeedsAttentionItems(a: NeedsAttentionItem, b: NeedsAttentionItem): number {
  const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severityDiff !== 0) return severityDiff;
  const timeDiff = needsAttentionTimestamp(b) - needsAttentionTimestamp(a);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

/**
 * One Needs Attention notification *event* is stored as one Notification
 * row per recipient (NotificationService.createForUserAndRoles: the
 * assigned dispatcher plus every ACTIVE ADMIN) so each user keeps their
 * own read state in the bell. An org-wide read therefore returns each
 * event once per recipient. Rows sharing (type, related entity) are copies
 * of a single event: the only producers (check-call reminder and load
 * lateness sweeps) never create a new event while any copy is still
 * unread.
 *
 * Copies of one event are written in one transaction, milliseconds apart.
 * A later event for the same (type, entity) can only come from a later
 * 15-minute sweep, after every earlier copy was read. So a viewer's READ
 * row within this window of the current unread copies is their copy of
 * this same event, and a READ row far outside it belongs to an older one.
 */
const SAME_NOTIFICATION_EVENT_WINDOW_MS = 60_000;

function notificationEventKey(
  n: Pick<Notification, 'type' | 'relatedEntityType' | 'relatedEntityId'>,
): string {
  return `${n.type}|${n.relatedEntityType ?? ''}|${n.relatedEntityId ?? ''}`;
}

function newestNotificationFirst(a: Notification, b: Notification): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * Collapses unread recipient copies to at most one row per logical event,
 * per viewer: the viewer's own unread copy; nothing if the viewer already
 * read their own copy of this event (another recipient's unread copy never
 * resurfaces it); otherwise — the viewer was not a recipient of this
 * event — the most recent unread copy. A viewer holding no copies at all
 * (the usual OPERATIONS_MANAGER case) therefore gets the plain org-wide
 * view, collapsed.
 */
function collapseNotificationCopies(
  unread: Notification[],
  viewerUserId: string,
  viewerReadCopies: Notification[],
): Notification[] {
  const copiesByEvent = new Map<string, Notification[]>();
  for (const n of unread) {
    const key = notificationEventKey(n);
    const copies = copiesByEvent.get(key);
    if (copies) copies.push(n);
    else copiesByEvent.set(key, [n]);
  }

  const result: Notification[] = [];
  for (const [key, copies] of copiesByEvent) {
    const newest = [...copies].sort(newestNotificationFirst)[0];
    const ownUnread = copies.find((n) => n.recipientUserId === viewerUserId);
    if (ownUnread) {
      result.push(ownUnread);
      continue;
    }

    const eventStart = Math.min(...copies.map((n) => n.createdAt.getTime()));
    const viewerReadThisEvent = viewerReadCopies.some(
      (n) =>
        notificationEventKey(n) === key &&
        n.createdAt.getTime() >= eventStart - SAME_NOTIFICATION_EVENT_WINDOW_MS,
    );
    if (!viewerReadThisEvent) result.push(newest);
  }
  return result;
}

/** Mirrors InvoiceController's own INVOICE_VIEW_ROLES exactly (Phase 6) — search must never surface an invoice to a role that couldn't view it directly. */
const INVOICE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'ACCOUNTING',
  'OPERATIONS_MANAGER',
  'SALES_BOOKING',
];

const AGING_BUCKET_KEYS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'days90plus',
] as const;
type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];
type AgingBuckets = Record<AgingBucketKey, { count: number; total: string }>;

function emptyBuckets(): AgingBuckets {
  return {
    current: { count: 0, total: '0.00' },
    days1to30: { count: 0, total: '0.00' },
    days31to60: { count: 0, total: '0.00' },
    days61to90: { count: 0, total: '0.00' },
    days90plus: { count: 0, total: '0.00' },
  };
}

/**
 * Decision 5 — Current = due today or later (daysPastDue <= 0); 1-30/31-60/
 * 61-90 inclusive on both ends; 90+ = 91 days past due or more.
 */
function bucketForDaysPastDue(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1to30';
  if (daysPastDue <= 60) return 'days31to60';
  if (daysPastDue <= 90) return 'days61to90';
  return 'days90plus';
}

function daysPastDue(anchorDate: Date, today: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((today.getTime() - anchorDate.getTime()) / msPerDay);
}

function addToBucket(buckets: AgingBuckets, key: AgingBucketKey, amount: number): void {
  buckets[key].count += 1;
  buckets[key].total = (Number(buckets[key].total) + amount).toFixed(2);
}

/**
 * Phase 8 (Reporting Foundation) — Global Search (§5.4, Decision B4),
 * AR/AP Aging (DATABASE_DESIGN.md §21, Decision D14), and a role-aware
 * Dashboard (PRD §9, minimal approved KPI set — Decision 3). No owned
 * tables (§1.2 — "read-only, cross-module queries"), so every query here
 * reads directly across modules rather than going through each entity's
 * own service layer, per §1.2's explicit exception for this module.
 */
@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * §5.4 — any authenticated session may call this; results are filtered,
   * not the endpoint. Load/Quote-style records reuse the existing
   * `shapeFinancialFieldsList` helper unmodified; Invoice reuses the same
   * "Account Owner, fallback creator" own-deal rule InvoiceService already
   * applies (Phase 6) — reimplemented here as a small local check rather
   * than touching InvoiceService, to avoid a Phase 6 locked-code edit for
   * a 3-line rule.
   */
  async search(
    organizationId: string,
    q: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const [loads, customers, carriers, invoices] = await Promise.all([
        tx.load.findMany({
          where: { organizationId, loadNumber: { contains: q, mode: 'insensitive' } },
          take: SEARCH_RESULT_LIMIT,
          orderBy: { createdAt: 'desc' },
        }),
        tx.customer.findMany({
          where: { organizationId, legalName: { contains: q, mode: 'insensitive' } },
          take: SEARCH_RESULT_LIMIT,
          orderBy: { legalName: 'asc' },
        }),
        tx.carrier.findMany({
          where: { organizationId, legalName: { contains: q, mode: 'insensitive' } },
          take: SEARCH_RESULT_LIMIT,
          orderBy: { legalName: 'asc' },
        }),
        this.searchInvoices(tx, organizationId, q, actingUserId, actingRoles),
      ]);

      return {
        loads: shapeFinancialFieldsList(loads, actingRoles, actingUserId),
        customers,
        carriers,
        invoices,
      };
    });
  }

  private async searchInvoices(
    tx: Prisma.TransactionClient,
    organizationId: string,
    q: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    if (!actingRoles.some((r) => INVOICE_VIEW_ROLES.includes(r))) return [];

    const invoices = await tx.invoice.findMany({
      where: { organizationId, invoiceNumber: { contains: q, mode: 'insensitive' } },
      take: SEARCH_RESULT_LIMIT,
      orderBy: { createdAt: 'desc' },
      include: { customer: true },
    });

    if (actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) return invoices;

    // Sales/Booking: full row for own-deal invoices, status-only for
    // others' — mirrors InvoiceService.list()'s own redaction exactly.
    return invoices.map((invoice) => {
      const isOwnDeal = invoice.customer.accountOwnerUserId
        ? invoice.customer.accountOwnerUserId === actingUserId
        : invoice.customer.createdByUserId === actingUserId;
      return isOwnDeal
        ? invoice
        : { ...invoice, total: null, remainingBalance: null, dueDate: null };
    });
  }

  /** DATABASE_DESIGN.md §21 — bucket outstanding, non-VOID Invoices by due_date. Gated to Admin/Accounting/Ops Manager at the controller. */
  async arAging(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.computeArAging(tx, organizationId),
    );
  }

  /**
   * Phase 21 (Reports Library) — identical data as `arAging` above, as
   * CSV, so AR Aging participates in the library's export behavior
   * without a second implementation of the bucket computation.
   */
  async arAgingCsv(organizationId: string): Promise<string> {
    const { buckets, grandTotal } = await this.arAging(organizationId);
    return this.agingBucketsToCsv(buckets, grandTotal);
  }

  private async computeArAging(tx: Prisma.TransactionClient, organizationId: string) {
    const today = new Date();
    const outstanding = await tx.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['SENT', 'PARTIALLY_PAID'] },
        remainingBalance: { gt: 0 },
      },
    });

    const buckets = emptyBuckets();
    let grandTotal = 0;
    for (const invoice of outstanding) {
      const amount = Number(invoice.remainingBalance);
      const days = invoice.dueDate ? daysPastDue(invoice.dueDate, today) : 0;
      addToBucket(buckets, bucketForDaysPastDue(days), amount);
      grandTotal += amount;
    }

    return { buckets, grandTotal: grandTotal.toFixed(2) };
  }

  /**
   * DATABASE_DESIGN.md §21, Decision D14 — outstanding balance per Load
   * (`carrierRate - SUM(PAID CarrierPayment.amount)`), bucketed by
   * `submitted_at`. D14 anchors on "the date the payment obligation was
   * formally submitted" without addressing multiple CarrierPayment rows
   * per Load — disclosed interpretation: use the OLDEST `submittedAt`
   * among that Load's non-PAID, already-submitted (submittedAt set,
   * i.e. not still DRAFT) rows, since that's the longest-outstanding
   * obligation. A Load with an outstanding balance but zero rows meeting
   * that condition (no CarrierPayment at all, or every row still DRAFT)
   * is excluded — D14's own text: "not yet aged, since no obligation has
   * been formally recorded."
   */
  async apAging(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.computeApAging(tx, organizationId),
    );
  }

  /** Phase 21 (Reports Library) — identical data as `apAging` above, as CSV. */
  async apAgingCsv(organizationId: string): Promise<string> {
    const { buckets, grandTotal } = await this.apAging(organizationId);
    return this.agingBucketsToCsv(buckets, grandTotal);
  }

  private agingBucketsToCsv(buckets: AgingBuckets, grandTotal: string): string {
    const labels: Record<AgingBucketKey, string> = {
      current: 'Current',
      days1to30: '1-30 Days',
      days31to60: '31-60 Days',
      days61to90: '61-90 Days',
      days90plus: '90+ Days',
    };
    const header = ['Bucket', 'Items', 'Total'];
    const rows = AGING_BUCKET_KEYS.map((key) => [
      labels[key],
      String(buckets[key].count),
      buckets[key].total,
    ]);
    rows.push(['Grand Total', '', grandTotal]);
    return toCsv([header, ...rows]);
  }

  private async computeApAging(tx: Prisma.TransactionClient, organizationId: string) {
    const today = new Date();
    const loads = await tx.load.findMany({
      where: { organizationId, assignedCarrierId: { not: null }, carrierRate: { not: null } },
      include: { carrierPayments: true },
    });

    const buckets = emptyBuckets();
    let grandTotal = 0;
    for (const load of loads) {
      const totalPaid = load.carrierPayments
        .filter((p) => p.status === 'PAID')
        .reduce((sum, p) => sum + Number(p.amount), 0);
      const outstanding = Number(load.carrierRate) - totalPaid;
      if (outstanding <= 0) continue;

      const unresolvedSubmittedDates = load.carrierPayments
        .filter((p) => p.status !== 'PAID' && p.submittedAt)
        .map((p) => p.submittedAt as Date);
      if (unresolvedSubmittedDates.length === 0) continue;

      const anchor = new Date(Math.min(...unresolvedSubmittedDates.map((d) => d.getTime())));
      const days = daysPastDue(anchor, today);
      addToBucket(buckets, bucketForDaysPastDue(days), outstanding);
      grandTotal += outstanding;
    }

    return { buckets, grandTotal: grandTotal.toFixed(2) };
  }

  /**
   * PRD §9 role-aware Dashboard — Decision 3's approved minimal KPI set.
   * Any authenticated user may call this (unlike AR/AP Aging); which
   * blocks appear depends on the caller's roles. A user holding
   * ADMIN/OPERATIONS_MANAGER gets every block, computed org-wide (Decision
   * 3's "org-wide versions of all of the above"); ACCOUNTING gets the
   * accounting block org-wide (it's inherently an org-wide role, matching
   * Decision 4's AR/AP-Aging role list); DISPATCHER/SALES_BOOKING get
   * their own block scoped to `actingUserId`. A caller holding none of
   * these roles (e.g. Compliance Reviewer only) gets an empty object — no
   * KPI was approved for that role.
   */
  async dashboard(organizationId: string, actingUserId: string, actingRoles: MembershipRoleName[]) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const isFullVisibility = actingRoles.some((r) => r === 'ADMIN' || r === 'OPERATIONS_MANAGER');

      const result: Record<string, unknown> = {};

      if (isFullVisibility || actingRoles.includes('DISPATCHER')) {
        result.dispatcher = await this.dispatcherBlock(
          tx,
          organizationId,
          isFullVisibility ? undefined : actingUserId,
        );
      }
      if (isFullVisibility || actingRoles.includes('SALES_BOOKING')) {
        result.sales = await this.salesBlock(
          tx,
          organizationId,
          isFullVisibility ? undefined : actingUserId,
        );
      }
      if (isFullVisibility || actingRoles.includes('ACCOUNTING')) {
        result.accounting = await this.accountingBlock(tx, organizationId);
      }

      return result;
    });
  }

  private async dispatcherBlock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    scopedToUserId: string | undefined,
  ) {
    const dispatcherFilter = scopedToUserId ? { assignedDispatcherId: scopedToUserId } : {};

    const activeLoads = await tx.load.count({
      where: {
        organizationId,
        status: { in: ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] },
        ...dispatcherFilter,
      },
    });
    const atRiskOrDelayed = await tx.load.count({
      where: { organizationId, riskStatus: { in: ['AT_RISK', 'DELAYED'] }, ...dispatcherFilter },
    });
    const overdueCheckCalls = await tx.notification.count({
      where: {
        organizationId,
        type: 'CHECK_CALL_OVERDUE',
        read: false,
        ...(scopedToUserId ? { recipientUserId: scopedToUserId } : {}),
      },
    });

    return { activeLoads, atRiskOrDelayed, overdueCheckCalls };
  }

  private async salesBlock(
    tx: Prisma.TransactionClient,
    organizationId: string,
    scopedToUserId: string | undefined,
  ) {
    const creatorFilter = scopedToUserId ? { createdByUserId: scopedToUserId } : {};

    const openQuotes = await tx.quote.count({
      where: { organizationId, status: 'OPEN', ...creatorFilter },
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const resolutionEvents = await tx.auditLog.findMany({
      where: {
        organizationId,
        entityType: 'Quote',
        action: {
          in: [
            'Quote Won — Converted to Load',
            'Quote Marked Lost',
            'Quote Expired — Automatically Marked Lost',
          ],
        },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { entityId: true, action: true },
    });

    const quoteIds = [...new Set(resolutionEvents.map((e) => e.entityId))];
    const quotes = quoteIds.length
      ? await tx.quote.findMany({
          where: { organizationId, id: { in: quoteIds }, ...creatorFilter },
          select: { id: true, status: true },
        })
      : [];
    const scopedQuoteIds = new Set(quotes.map((q) => q.id));

    const wonLast30 = resolutionEvents.filter(
      (e) => e.action === 'Quote Won — Converted to Load' && scopedQuoteIds.has(e.entityId),
    ).length;
    const lostLast30 = resolutionEvents.filter(
      (e) => e.action !== 'Quote Won — Converted to Load' && scopedQuoteIds.has(e.entityId),
    ).length;
    const winRate = wonLast30 + lostLast30 === 0 ? 0 : wonLast30 / (wonLast30 + lostLast30);

    return { openQuotes, wonLast30, lostLast30, winRate };
  }

  private async accountingBlock(tx: Prisma.TransactionClient, organizationId: string) {
    const [arAging, apAging, pendingCarrierPayments] = await Promise.all([
      this.computeArAging(tx, organizationId),
      this.computeApAging(tx, organizationId),
      tx.carrierPayment.count({ where: { organizationId, status: 'PENDING_APPROVAL' } }),
    ]);

    const arOverdue = (
      Number(arAging.buckets.days1to30.total) +
      Number(arAging.buckets.days31to60.total) +
      Number(arAging.buckets.days61to90.total) +
      Number(arAging.buckets.days90plus.total)
    ).toFixed(2);

    return {
      arOutstanding: arAging.grandTotal,
      arOverdue,
      apOutstanding: apAging.grandTotal,
      pendingCarrierPayments,
    };
  }

  /**
   * Dashboard Map Phase — "Truck Locations & Destinations". Reuses the
   * exact dispatcher-scoping rule already approved for `dispatcherBlock`
   * (org-wide for ADMIN/OPERATIONS_MANAGER, else scoped to the caller's
   * own `assignedDispatcherId` loads) — this is Dispatch-domain data, not
   * a new visibility decision. Returns raw stops per load rather than a
   * pre-computed origin/destination string, so the frontend's existing
   * `originDestination()` derivation (loadDerived.ts) is reused instead
   * of being re-implemented here. Never returns a location for a truck
   * that has none — `lastKnownLocation` is `null`, not a guessed value,
   * whenever `Load.currentLocationCity/State` is unset (i.e. no Check
   * Call has ever been logged for that Load).
   */
  async fleetMap(organizationId: string, actingUserId: string, actingRoles: MembershipRoleName[]) {
    const isFullVisibility = actingRoles.some((r) => r === 'ADMIN' || r === 'OPERATIONS_MANAGER');
    if (!isFullVisibility && !actingRoles.includes('DISPATCHER')) {
      return { activeTrucks: [], availableTrucks: [] };
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const dispatcherFilter = isFullVisibility ? {} : { assignedDispatcherId: actingUserId };

      const dispatchRecords = await tx.dispatchRecord.findMany({
        where: {
          organizationId,
          load: { status: { in: ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] }, ...dispatcherFilter },
        },
        include: {
          load: {
            select: {
              id: true,
              loadNumber: true,
              status: true,
              riskStatus: true,
              assignedCarrierId: true,
              currentLocationCity: true,
              currentLocationState: true,
              currentLocationDescription: true,
              currentLocationUpdatedAt: true,
              currentLocationLat: true,
              currentLocationLng: true,
              currentEta: true,
              stops: {
                select: {
                  sequence: true,
                  stopType: true,
                  stopPurpose: true,
                  city: true,
                  state: true,
                },
                orderBy: { sequence: 'asc' },
              },
            },
          },
        },
      });

      const activeTrucks = dispatchRecords.map((d) => ({
        truckNumber: d.truckNumber,
        driverName: d.driverName,
        loadId: d.load.id,
        loadNumber: d.load.loadNumber,
        loadStatus: d.load.status,
        riskStatus: d.load.riskStatus,
        assignedCarrierId: d.load.assignedCarrierId,
        lastKnownLocation:
          d.load.currentLocationCity && d.load.currentLocationState
            ? {
                city: d.load.currentLocationCity,
                state: d.load.currentLocationState,
                description: d.load.currentLocationDescription,
                updatedAt: d.load.currentLocationUpdatedAt,
                // Dashboard Map Phase 2 — server-resolved coordinates,
                // when the resolve-location worker has already handled
                // this Load's latest Check Call. Null until then — the
                // frontend falls back to its own client-side dataset
                // lookup, exactly as before this phase (see
                // fleetMapData.ts's own doc comment on this).
                lat: d.load.currentLocationLat !== null ? Number(d.load.currentLocationLat) : null,
                lng: d.load.currentLocationLng !== null ? Number(d.load.currentLocationLng) : null,
              }
            : null,
        currentEta: d.load.currentEta,
        stops: d.load.stops,
      }));

      // "Available trucks" is an org-wide fleet fact, not a per-dispatcher
      // one — only computed for full-visibility callers, same principle
      // as every other org-wide-only block in this service.
      let availableTrucks: {
        truckId: string;
        unitNumber: string;
        carrierId: string;
        carrierLegalName: string;
      }[] = [];
      if (isFullVisibility) {
        const dispatchedTruckIds = (
          await tx.dispatchRecord.findMany({
            where: {
              organizationId,
              sourceTruckId: { not: null },
              load: { status: { in: ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] } },
            },
            select: { sourceTruckId: true },
          })
        )
          .map((d) => d.sourceTruckId)
          .filter((id): id is string => id !== null);

        const trucks = await tx.truck.findMany({
          where: { organizationId, active: true, id: { notIn: dispatchedTruckIds } },
          include: { carrier: { select: { legalName: true } } },
        });

        availableTrucks = trucks.map((t) => ({
          truckId: t.id,
          unitNumber: t.unitNumber,
          carrierId: t.carrierId,
          carrierLegalName: t.carrier.legalName,
        }));
      }

      return { activeTrucks, availableTrucks };
    });
  }

  /**
   * Dashboard "Needs Attention Today" — B.5 combines two sources into one
   * normalized, sorted, paginated list:
   *  - legacy `Notification` rows (CHECK_CALL_OVERDUE, LOAD_LATE,
   *    CHECK_CALL_DUE_SOON) — unchanged query/behavior from the original
   *    (Phase 8) version, just normalized into the shared shape below;
   *  - active `AttentionItem` rows (Needs Attention V2 — B.2/B.3/future
   *    detectors all fit this same response shape automatically, since
   *    nothing here is specific to any one `AttentionType`).
   * Both sources are fetched (bounded by NEEDS_ATTENTION_SOURCE_FETCH_CAP
   * each), normalized, combined, sorted by severity-then-recency, and
   * *then* paginated — pagination must happen after combining, or page 2
   * of a mixed list would be wrong. AttentionItem's own lifecycle stays
   * entirely sweep-driven — this method only ever reads `status: 'ACTIVE'`
   * rows, no acknowledge/resolve action exists or is added here.
   */
  async needsAttention(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    page: number,
    pageSize: number,
  ): Promise<NeedsAttentionResult> {
    const isFullVisibility = actingRoles.some((r) => r === 'ADMIN' || r === 'OPERATIONS_MANAGER');
    const isDispatcher = actingRoles.includes('DISPATCHER');
    if (!isFullVisibility && !isDispatcher) {
      return { items: [], total: 0, page, pageSize };
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const unreadNotifications = await tx.notification.findMany({
        where: {
          organizationId,
          type: { in: [...NEEDS_ATTENTION_NOTIFICATION_TYPES] },
          read: false,
          // Legacy Notifications keep their existing per-recipient scoping
          // for a Dispatcher — this is a different mechanism from the
          // AttentionItem scoping below (Load.assignedDispatcherId), not
          // a shared filter.
          ...(isFullVisibility ? {} : { recipientUserId: actingUserId }),
        },
        orderBy: { createdAt: 'desc' },
        take: NEEDS_ATTENTION_SOURCE_FETCH_CAP,
      });

      // A Dispatcher's rows are already their own copies (one per event);
      // only the org-wide read needs recipient copies collapsed — and that
      // must happen before total/pagination below.
      const notifications = isFullVisibility
        ? collapseNotificationCopies(
            unreadNotifications,
            actingUserId,
            await this.findViewerReadNotificationCopies(
              tx,
              organizationId,
              actingUserId,
              unreadNotifications,
            ),
          )
        : unreadNotifications;

      const attentionItems = await tx.attentionItem.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          ...(isFullVisibility ? {} : { load: { assignedDispatcherId: actingUserId } }),
        },
        orderBy: { detectedAt: 'desc' },
        take: NEEDS_ATTENTION_SOURCE_FETCH_CAP,
      });

      // Single batched Load lookup across BOTH sources — no per-item query.
      const loadIds = [
        ...new Set([
          ...notifications
            .filter((n) => n.relatedEntityType === 'Load' && n.relatedEntityId !== null)
            .map((n) => n.relatedEntityId as string),
          ...attentionItems.map((a) => a.loadId),
        ]),
      ];
      const loads = loadIds.length
        ? await tx.load.findMany({
            where: { organizationId, id: { in: loadIds } },
            select: { id: true, loadNumber: true },
          })
        : [];
      const loadNumberById = new Map(loads.map((l) => [l.id, l.loadNumber]));

      const fromNotifications: NeedsAttentionItem[] = notifications
        .filter(
          (n) =>
            n.relatedEntityType === 'Load' &&
            n.relatedEntityId !== null &&
            loadNumberById.has(n.relatedEntityId),
        )
        .map((n) => ({
          id: n.id,
          source: 'NOTIFICATION',
          type: n.type,
          severity: NOTIFICATION_SEVERITY[n.type as NeedsAttentionNotificationType],
          status: null,
          title: null,
          message: n.message,
          reason: null,
          impact: null,
          suggestedActions: null,
          metadata: null,
          loadId: n.relatedEntityId as string,
          loadNumber: loadNumberById.get(n.relatedEntityId as string) as string,
          createdAt: n.createdAt,
          detectedAt: null,
          updatedAt: null,
          resolvedAt: null,
        }));

      const fromAttentionItems: NeedsAttentionItem[] = attentionItems
        .filter((a) => loadNumberById.has(a.loadId))
        .map((a) => ({
          id: a.id,
          source: 'ATTENTION_ITEM',
          type: a.type,
          severity: a.severity,
          status: a.status,
          title: a.title,
          message: null,
          reason: a.reason,
          impact: a.impact,
          suggestedActions: a.suggestedActions,
          metadata: a.metadata,
          loadId: a.loadId,
          loadNumber: loadNumberById.get(a.loadId) as string,
          createdAt: null,
          detectedAt: a.detectedAt,
          updatedAt: a.updatedAt,
          resolvedAt: a.resolvedAt,
        }));

      const combined = [...fromNotifications, ...fromAttentionItems].sort(
        compareNeedsAttentionItems,
      );

      const total = combined.length;
      const start = (page - 1) * pageSize;
      const items = combined.slice(start, start + pageSize);

      return { items, total, page, pageSize };
    });
  }

  /**
   * The viewer's own READ copies of the events in `unread` — only for
   * events where they hold no unread copy, and only rows recent enough to
   * belong to those events (see SAME_NOTIFICATION_EVENT_WINDOW_MS). Skips
   * the query entirely when there is nothing to check.
   */
  private async findViewerReadNotificationCopies(
    tx: Prisma.TransactionClient,
    organizationId: string,
    viewerUserId: string,
    unread: Notification[],
  ): Promise<Notification[]> {
    const ownUnreadKeys = new Set(
      unread.filter((n) => n.recipientUserId === viewerUserId).map(notificationEventKey),
    );
    const toCheck = unread.filter(
      (n) => n.relatedEntityId !== null && !ownUnreadKeys.has(notificationEventKey(n)),
    );
    if (toCheck.length === 0) return [];

    const oldest = Math.min(...toCheck.map((n) => n.createdAt.getTime()));
    return tx.notification.findMany({
      where: {
        organizationId,
        recipientUserId: viewerUserId,
        read: true,
        type: { in: [...new Set(toCheck.map((n) => n.type))] },
        relatedEntityId: { in: [...new Set(toCheck.map((n) => n.relatedEntityId as string))] },
        createdAt: { gte: new Date(oldest - SAME_NOTIFICATION_EVENT_WINDOW_MS) },
      },
    });
  }
}
