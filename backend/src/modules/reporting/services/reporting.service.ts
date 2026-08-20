import { Injectable } from '@nestjs/common';
import { MembershipRoleName, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shapeFinancialFieldsList } from '../../quote-load/services/financial-field-shaping';

const SEARCH_RESULT_LIMIT = 5;

/** Mirrors InvoiceController's own INVOICE_VIEW_ROLES exactly (Phase 6) — search must never surface an invoice to a role that couldn't view it directly. */
const INVOICE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'ACCOUNTING',
  'OPERATIONS_MANAGER',
  'SALES_BOOKING',
];
const INVOICE_FULL_VIEW_ROLES: MembershipRoleName[] = ['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'];

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

    if (actingRoles.some((r) => INVOICE_FULL_VIEW_ROLES.includes(r))) return invoices;

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
}
