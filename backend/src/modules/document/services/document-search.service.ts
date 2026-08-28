import { Injectable } from '@nestjs/common';
import { DocumentEntityType, MembershipRoleName, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';
import { toCsv } from '../../quote-load/utils/csv';

export type DocumentSearchSort = 'fileName' | 'documentType' | 'uploadedAt';
export type DocumentSearchSortDirection = 'asc' | 'desc';

export interface DocumentSearchFilters {
  q?: string;
  entityType?: DocumentEntityType;
  documentTypeId?: string;
  scanStatus?: string;
  reviewStatus?: string;
  generationStatus?: string;
  uploadedFrom?: string;
  uploadedTo?: string;
  sort?: DocumentSearchSort;
  sortDirection?: DocumentSearchSortDirection;
}

export interface DocumentSearchPagination {
  page: number;
  pageSize: number;
}

export interface DocumentSearchResultRow {
  id: string;
  fileName: string;
  documentTypeLabel: string;
  entityType: DocumentEntityType;
  entityId: string;
  entityLabel: string;
  entityLinkPath: string;
  scanStatus: string;
  reviewStatus: string | null;
  generationStatus: string | null;
  uploadedByUserId: string;
  uploadedByName: string;
  uploadedAt: Date;
}

export interface DocumentSearchResult {
  items: DocumentSearchResultRow[];
  total: number;
  page: number;
  pageSize: number;
}

type TenantTx = Prisma.TransactionClient;

/**
 * Frontend Phase 20 (Document Center) — a cross-entity search over
 * `Document`, which has NO native FK on `entityId` (polymorphic —
 * schema.prisma's own comment: "entity existence/access is checked in
 * DocumentService, not the database"). Every cross-entity-type lookup
 * below is therefore a small, bounded, indexed pre-query against the
 * owning entity's own table — never a Prisma `include` (impossible here)
 * and never a full-table fetch filtered in memory.
 *
 * Visibility for CARRIER_PAYMENT and INVOICE-type documents exactly
 * replicates the existing, already-locked rules from
 * `CarrierPaymentController`/`CarrierPaymentService` (`FINANCIAL_VIEW_ROLES`
 * — Admin/Accounting/Operations Manager only, no ownership carve-out) and
 * `InvoiceService.findById`/`isOwnDeal` (full-visibility roles see
 * everything; Sales/Booking sees only their own-deal invoices via the
 * parent Customer's `accountOwnerUserId`, falling back to
 * `createdByUserId`; every other role — i.e. Dispatcher — sees none,
 * matching `INVOICE_VIEW_ROLES`'s exclusion of Dispatcher entirely).
 * Every other entity type documents can attach to (Load/Stop, Customer,
 * Carrier, Driver, Truck, Trailer) has no `@Roles()` restriction or
 * ownership concept on its own view routes today, so no additional
 * filtering is applied for them — reusing the absence of a rule is still
 * reusing the rule.
 */
@Injectable()
export class DocumentSearchService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveInvoiceVisibility(
    tx: TenantTx,
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ): Promise<'ALL' | 'NONE' | string[]> {
    if (actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) return 'ALL';
    if (!actingRoles.includes('SALES_BOOKING')) return 'NONE';

    const owned = await tx.invoice.findMany({
      where: {
        organizationId,
        OR: [
          { customer: { accountOwnerUserId: actingUserId } },
          { customer: { accountOwnerUserId: null, createdByUserId: actingUserId } },
        ],
      },
      select: { id: true },
    });
    return owned.map((o) => o.id);
  }

  /**
   * Tier 1 (direct Document fields) + Tier 2 (immediate owning-entity
   * identifier only — Tier 3/2-hop search, e.g. finding a Load's document
   * by its assigned Carrier's name, is explicitly deferred). Each entity
   * type below gets one small, capped, organization-scoped id lookup;
   * results are OR'd together with the Tier-1 clause. STOP (POD)
   * documents resolve through their parent Load's `loadNumber`, since a
   * Stop has no identifying text of its own.
   */
  private async resolveSearchClauses(
    tx: TenantTx,
    organizationId: string,
    q: string,
  ): Promise<Prisma.DocumentWhereInput[]> {
    const insensitive = { contains: q, mode: 'insensitive' as const };
    const cap = { take: 200 };

    const [loads, customers, carriers, drivers, trucks, trailers, invoices, carrierPayments] =
      await Promise.all([
        tx.load.findMany({
          where: { organizationId, loadNumber: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.customer.findMany({
          where: { organizationId, legalName: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.carrier.findMany({
          where: { organizationId, legalName: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.driver.findMany({
          where: {
            organizationId,
            OR: [{ firstName: insensitive }, { lastName: insensitive }],
          },
          select: { id: true },
          ...cap,
        }),
        tx.truck.findMany({
          where: { organizationId, unitNumber: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.trailer.findMany({
          where: { organizationId, unitNumber: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.invoice.findMany({
          where: { organizationId, invoiceNumber: insensitive },
          select: { id: true },
          ...cap,
        }),
        tx.carrierPayment.findMany({
          where: { organizationId, referenceNumber: insensitive },
          select: { id: true },
          ...cap,
        }),
      ]);

    const clauses: Prisma.DocumentWhereInput[] = [
      { fileName: insensitive },
      { documentType: { label: insensitive } },
      { customTypeLabel: insensitive },
    ];

    const loadIds = loads.map((l) => l.id);
    if (loadIds.length > 0) {
      clauses.push({ entityType: 'LOAD', entityId: { in: loadIds } });

      const stops = await tx.stop.findMany({
        where: { organizationId, loadId: { in: loadIds } },
        select: { id: true },
        ...cap,
      });
      if (stops.length > 0) {
        clauses.push({ entityType: 'STOP', entityId: { in: stops.map((s) => s.id) } });
      }
    }
    if (customers.length > 0) {
      clauses.push({ entityType: 'CUSTOMER', entityId: { in: customers.map((c) => c.id) } });
    }
    if (carriers.length > 0) {
      clauses.push({ entityType: 'CARRIER', entityId: { in: carriers.map((c) => c.id) } });
    }
    if (drivers.length > 0) {
      clauses.push({ entityType: 'DRIVER', entityId: { in: drivers.map((d) => d.id) } });
    }
    if (trucks.length > 0) {
      clauses.push({ entityType: 'TRUCK', entityId: { in: trucks.map((t) => t.id) } });
    }
    if (trailers.length > 0) {
      clauses.push({ entityType: 'TRAILER', entityId: { in: trailers.map((t) => t.id) } });
    }
    if (invoices.length > 0) {
      clauses.push({ entityType: 'INVOICE', entityId: { in: invoices.map((i) => i.id) } });
    }
    if (carrierPayments.length > 0) {
      clauses.push({
        entityType: 'CARRIER_PAYMENT',
        entityId: { in: carrierPayments.map((p) => p.id) },
      });
    }

    return clauses;
  }

  private async buildWhere(
    tx: TenantTx,
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: DocumentSearchFilters,
  ): Promise<Prisma.DocumentWhereInput> {
    const where: Prisma.DocumentWhereInput = {
      organizationId,
      isCurrentVersion: true,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.documentTypeId ? { documentTypeId: filters.documentTypeId } : {}),
      ...(filters.scanStatus ? { scanStatus: filters.scanStatus as never } : {}),
      ...(filters.reviewStatus ? { reviewStatus: filters.reviewStatus as never } : {}),
      ...(filters.generationStatus ? { generationStatus: filters.generationStatus as never } : {}),
      ...(filters.uploadedFrom || filters.uploadedTo
        ? {
            uploadedAt: {
              ...(filters.uploadedFrom ? { gte: new Date(filters.uploadedFrom) } : {}),
              ...(filters.uploadedTo ? { lte: new Date(filters.uploadedTo) } : {}),
            },
          }
        : {}),
    };

    const q = filters.q?.trim();
    if (q) {
      const clauses = await this.resolveSearchClauses(tx, organizationId, q);
      where.OR = clauses;
    }

    const exclusions: Prisma.DocumentWhereInput[] = [];
    const carrierPaymentAllowed = actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r));
    if (!carrierPaymentAllowed) {
      exclusions.push({ entityType: { not: 'CARRIER_PAYMENT' } });
    }

    const invoiceVisibility = await this.resolveInvoiceVisibility(
      tx,
      organizationId,
      actingUserId,
      actingRoles,
    );
    if (invoiceVisibility === 'NONE') {
      exclusions.push({ entityType: { not: 'INVOICE' } });
    } else if (Array.isArray(invoiceVisibility)) {
      exclusions.push({
        NOT: { entityType: 'INVOICE', entityId: { notIn: invoiceVisibility } },
      });
    }

    if (exclusions.length > 0) {
      where.AND = exclusions;
    }

    return where;
  }

  private buildOrderBy(
    sort: DocumentSearchSort | undefined,
    direction: DocumentSearchSortDirection | undefined,
  ): Prisma.DocumentOrderByWithRelationInput {
    const dir = direction ?? 'desc';
    if (sort === 'fileName') return { fileName: dir };
    if (sort === 'documentType') return { documentType: { label: dir } };
    return { uploadedAt: dir };
  }

  /**
   * Page-scoped only — never resolves labels for more than the current
   * page's rows, mirroring `DocumentService.listPendingReview()`'s own
   * "one bounded follow-up query rather than a Prisma include" precedent,
   * generalized from one entity type to however many appear on the page.
   */
  private async resolveEntityLabels(
    tx: TenantTx,
    organizationId: string,
    rows: { entityType: DocumentEntityType; entityId: string }[],
  ): Promise<Map<string, { label: string; linkPath: string }>> {
    const result = new Map<string, { label: string; linkPath: string }>();
    const idsByType = new Map<DocumentEntityType, string[]>();
    for (const row of rows) {
      const list = idsByType.get(row.entityType) ?? [];
      list.push(row.entityId);
      idsByType.set(row.entityType, list);
    }

    const loadIds = idsByType.get('LOAD') ?? [];
    const stopIds = idsByType.get('STOP') ?? [];
    const customerIds = idsByType.get('CUSTOMER') ?? [];
    const carrierIds = idsByType.get('CARRIER') ?? [];
    const driverIds = idsByType.get('DRIVER') ?? [];
    const truckIds = idsByType.get('TRUCK') ?? [];
    const trailerIds = idsByType.get('TRAILER') ?? [];
    const invoiceIds = idsByType.get('INVOICE') ?? [];
    const carrierPaymentIds = idsByType.get('CARRIER_PAYMENT') ?? [];

    const [loads, stops, customers, carriers, drivers, trucks, trailers, invoices, payments] =
      await Promise.all([
        loadIds.length
          ? tx.load.findMany({
              where: { id: { in: loadIds }, organizationId },
              select: { id: true, loadNumber: true },
            })
          : [],
        stopIds.length
          ? tx.stop.findMany({
              where: { id: { in: stopIds }, organizationId },
              select: { id: true, load: { select: { id: true, loadNumber: true } } },
            })
          : [],
        customerIds.length
          ? tx.customer.findMany({
              where: { id: { in: customerIds }, organizationId },
              select: { id: true, legalName: true },
            })
          : [],
        carrierIds.length
          ? tx.carrier.findMany({
              where: { id: { in: carrierIds }, organizationId },
              select: { id: true, legalName: true },
            })
          : [],
        driverIds.length
          ? tx.driver.findMany({
              where: { id: { in: driverIds }, organizationId },
              select: { id: true, firstName: true, lastName: true, carrierId: true },
            })
          : [],
        truckIds.length
          ? tx.truck.findMany({
              where: { id: { in: truckIds }, organizationId },
              select: { id: true, unitNumber: true, carrierId: true },
            })
          : [],
        trailerIds.length
          ? tx.trailer.findMany({
              where: { id: { in: trailerIds }, organizationId },
              select: { id: true, unitNumber: true, carrierId: true },
            })
          : [],
        invoiceIds.length
          ? tx.invoice.findMany({
              where: { id: { in: invoiceIds }, organizationId },
              select: { id: true, invoiceNumber: true },
            })
          : [],
        carrierPaymentIds.length
          ? tx.carrierPayment.findMany({
              where: { id: { in: carrierPaymentIds }, organizationId },
              select: { id: true, paymentType: true, referenceNumber: true },
            })
          : [],
      ]);

    for (const l of loads) {
      result.set(`LOAD:${l.id}`, { label: l.loadNumber, linkPath: `/loads/${l.id}` });
    }
    for (const s of stops) {
      if (s.load) {
        result.set(`STOP:${s.id}`, {
          label: s.load.loadNumber,
          linkPath: `/loads/${s.load.id}`,
        });
      }
    }
    for (const c of customers) {
      result.set(`CUSTOMER:${c.id}`, { label: c.legalName, linkPath: `/customers/${c.id}` });
    }
    for (const c of carriers) {
      result.set(`CARRIER:${c.id}`, { label: c.legalName, linkPath: `/carriers/${c.id}` });
    }
    for (const d of drivers) {
      result.set(`DRIVER:${d.id}`, {
        label: `${d.firstName} ${d.lastName}`,
        linkPath: `/carriers/${d.carrierId}`,
      });
    }
    for (const t of trucks) {
      result.set(`TRUCK:${t.id}`, { label: t.unitNumber, linkPath: `/carriers/${t.carrierId}` });
    }
    for (const t of trailers) {
      result.set(`TRAILER:${t.id}`, {
        label: t.unitNumber,
        linkPath: `/carriers/${t.carrierId}`,
      });
    }
    for (const i of invoices) {
      result.set(`INVOICE:${i.id}`, {
        label: i.invoiceNumber,
        linkPath: `/billing/invoices/${i.id}`,
      });
    }
    for (const p of payments) {
      result.set(`CARRIER_PAYMENT:${p.id}`, {
        label: p.referenceNumber ?? p.paymentType,
        linkPath: `/billing/carrier-pay/${p.id}`,
      });
    }

    return result;
  }

  private async toResultRows(
    tx: TenantTx,
    organizationId: string,
    documents: Array<{
      id: string;
      fileName: string;
      documentType: { label: string };
      entityType: DocumentEntityType;
      entityId: string;
      scanStatus: string;
      reviewStatus: string | null;
      generationStatus: string | null;
      uploadedByUserId: string;
      uploadedBy: { name: string };
      uploadedAt: Date;
    }>,
  ): Promise<DocumentSearchResultRow[]> {
    const labels = await this.resolveEntityLabels(tx, organizationId, documents);
    return documents.map((d) => {
      const resolved = labels.get(`${d.entityType}:${d.entityId}`);
      return {
        id: d.id,
        fileName: d.fileName,
        documentTypeLabel: d.documentType.label,
        entityType: d.entityType,
        entityId: d.entityId,
        entityLabel: resolved?.label ?? d.entityId,
        entityLinkPath: resolved?.linkPath ?? '',
        scanStatus: d.scanStatus,
        reviewStatus: d.reviewStatus,
        generationStatus: d.generationStatus,
        uploadedByUserId: d.uploadedByUserId,
        uploadedByName: d.uploadedBy.name,
        uploadedAt: d.uploadedAt,
      };
    });
  }

  async search(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: DocumentSearchFilters,
    pagination: DocumentSearchPagination,
  ): Promise<DocumentSearchResult> {
    const { page, pageSize } = pagination;

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const where = await this.buildWhere(tx, organizationId, actingUserId, actingRoles, filters);
      const [total, documents] = await Promise.all([
        tx.document.count({ where }),
        tx.document.findMany({
          where,
          include: { documentType: true, uploadedBy: true },
          orderBy: this.buildOrderBy(filters.sort, filters.sortDirection),
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      const items = await this.toResultRows(tx, organizationId, documents);
      return { items, total, page, pageSize };
    });
  }

  /**
   * Decision (mirrors LoadSearchService.exportCsv) — every matching row,
   * never paginated. Uses the exact same `buildWhere` as `search`, so
   * tenant isolation, entity visibility, and the CARRIER_PAYMENT/INVOICE
   * exclusions are identical between the interactive and export paths by
   * construction, not by parallel maintenance.
   */
  async exportCsv(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: DocumentSearchFilters,
  ): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const where = await this.buildWhere(tx, organizationId, actingUserId, actingRoles, filters);
      const documents = await tx.document.findMany({
        where,
        include: { documentType: true, uploadedBy: true },
        orderBy: this.buildOrderBy(filters.sort, filters.sortDirection),
      });

      const items = await this.toResultRows(tx, organizationId, documents);
      const header = [
        'File Name',
        'Document Type',
        'Entity Type',
        'Entity Identifier',
        'Scan Status',
        'Review Status',
        'Generation Status',
        'Uploaded By',
        'Uploaded At',
      ];
      const rows = items.map((i) => [
        i.fileName,
        i.documentTypeLabel,
        i.entityType,
        i.entityLabel,
        i.scanStatus,
        i.reviewStatus ?? '',
        i.generationStatus ?? '',
        i.uploadedByName,
        i.uploadedAt.toISOString(),
      ]);
      return toCsv([header, ...rows]);
    });
  }
}
