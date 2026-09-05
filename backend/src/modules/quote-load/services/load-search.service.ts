import { Injectable } from '@nestjs/common';
import {
  EquipmentType,
  Load,
  MembershipRoleName,
  Prisma,
  RiskStatus,
  StopPurpose,
  StopType,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shapeFinancialFieldsList } from './financial-field-shaping';
import { toCsv } from '../utils/csv';

export type LoadSearchSort = 'loadNumber' | 'pickupDate' | 'deliveryDate';
export type LoadSearchSortDirection = 'asc' | 'desc';

export interface LoadSearchFilters {
  status?: string;
  customerId?: string;
  carrierId?: string;
  dispatcherId?: string;
  equipmentType?: string;
  riskStatus?: string;
  pickupFrom?: string;
  pickupTo?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  q?: string;
  sort?: LoadSearchSort;
  sortDirection?: LoadSearchSortDirection;
  /**
   * Frontend Phase 18 — export-only: when present, scopes the export to
   * exactly this explicit set of Load ids (Dispatch Board's "Export
   * Selected"). Combines with `organizationId` in `buildWhere` the same
   * as every other filter — RLS/tenant isolation is never bypassed by
   * an id list, it only narrows an already-tenant-scoped query.
   */
  ids?: string[];
  /**
   * Frontend Phase 18 — export-only: mirrors Dispatch Board Table View's
   * own default client-side rule (`status !== 'CLOSED' && status !==
   * 'CANCELLED'`, updated by the Cancel Load workflow) for the
   * page-level filtered Export button, which has no other way to
   * express "not Closed/Cancelled" through the single-value `status`
   * filter above. Ignored whenever `status` is explicitly set — an
   * explicit status always wins, never combined with this.
   */
  excludeClosed?: boolean;
}

export interface LoadSearchPagination {
  page: number;
  pageSize: number;
}

export interface LoadSearchResult {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
}

interface StopDateRow {
  sequence: number;
  appointmentDatetime: Date | null;
  stopType: StopType;
  stopPurpose: StopPurpose;
}

/**
 * Matches `frontend/src/routes/loads/loadDerived.ts`'s `firstPickupDate` /
 * `lastDeliveryDate` exactly (lowest-sequence PICKUP / highest-sequence
 * DELIVERY) — the user explicitly required this backend logic not
 * silently diverge into a min/max-appointmentDatetime approximation.
 * Return Product feature — also filters to `stopPurpose: STANDARD`, so a
 * return leg's stops never affect the Dispatch Board's Pickup/Delivery
 * Date columns or sort.
 */
function pickStopDate(stops: StopDateRow[], stopType: 'PICKUP' | 'DELIVERY'): Date | null {
  // `?? 'STANDARD'` — same defensive treatment as
  // LoadStatusDerivationService.deriveLoadStatus: a real DB row always has
  // the schema default, this only guards a partial/malformed input.
  const matching = stops.filter(
    (s) => s.stopType === stopType && (s.stopPurpose ?? 'STANDARD') === 'STANDARD',
  );
  if (matching.length === 0) return null;
  const picked =
    stopType === 'PICKUP'
      ? matching.reduce((a, b) => (b.sequence < a.sequence ? b : a))
      : matching.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  return picked.appointmentDatetime;
}

const CSV_HEADER = [
  'Load #',
  'Customer',
  'Status',
  'Risk',
  'Carrier',
  'Dispatcher',
  'Origin → Destination',
  'Pickup Date',
  'Delivery Date',
  'Equipment',
  'Customer Rate',
  'Carrier Rate',
];

@Injectable()
export class LoadSearchService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(organizationId: string, filters: LoadSearchFilters): Prisma.LoadWhereInput {
    const stopFilters: Prisma.StopWhereInput[] = [];
    if (filters.pickupFrom || filters.pickupTo) {
      stopFilters.push({
        stopType: 'PICKUP',
        appointmentDatetime: {
          ...(filters.pickupFrom ? { gte: new Date(filters.pickupFrom) } : {}),
          ...(filters.pickupTo ? { lte: new Date(filters.pickupTo) } : {}),
        },
      });
    }
    if (filters.deliveryFrom || filters.deliveryTo) {
      stopFilters.push({
        stopType: 'DELIVERY',
        appointmentDatetime: {
          ...(filters.deliveryFrom ? { gte: new Date(filters.deliveryFrom) } : {}),
          ...(filters.deliveryTo ? { lte: new Date(filters.deliveryTo) } : {}),
        },
      });
    }

    const q = filters.q?.trim();

    return {
      organizationId,
      ...(filters.status
        ? { status: filters.status as Load['status'] }
        : filters.excludeClosed
          ? { status: { notIn: ['CLOSED', 'CANCELLED'] as Load['status'][] } }
          : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.carrierId ? { assignedCarrierId: filters.carrierId } : {}),
      ...(filters.dispatcherId ? { assignedDispatcherId: filters.dispatcherId } : {}),
      ...(filters.equipmentType ? { equipmentType: filters.equipmentType as EquipmentType } : {}),
      ...(filters.riskStatus ? { riskStatus: filters.riskStatus as RiskStatus } : {}),
      ...(filters.ids && filters.ids.length > 0 ? { id: { in: filters.ids } } : {}),
      ...(stopFilters.length ? { AND: stopFilters.map((sf) => ({ stops: { some: sf } })) } : {}),
      ...(q
        ? {
            OR: [
              { loadNumber: { contains: q, mode: 'insensitive' as const } },
              { customer: { legalName: { contains: q, mode: 'insensitive' as const } } },
              { assignedCarrier: { legalName: { contains: q, mode: 'insensitive' as const } } },
              {
                stops: {
                  some: {
                    OR: [
                      { city: { contains: q, mode: 'insensitive' as const } },
                      { state: { contains: q, mode: 'insensitive' as const } },
                      { addressLine1: { contains: q, mode: 'insensitive' as const } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
  }

  /**
   * Bounded, DB-level derivation for the two date-sort paths — fetches
   * only `{loadId, sequence, appointmentDatetime}` tuples for the given
   * stopType across the already-filtered load set, never full Load rows.
   * Kept as its own method (not reusing `pickStopDate` on a
   * pre-`include`d `stops` array) specifically so the paginated
   * interactive-search path never has to materialize every matching
   * Load's full row + all its Stops into memory just to sort.
   */
  private async deriveSortDates(
    tx: Prisma.TransactionClient,
    loadIds: string[],
    stopType: 'PICKUP' | 'DELIVERY',
  ): Promise<Map<string, Date | null>> {
    const stops = await tx.stop.findMany({
      where: { loadId: { in: loadIds }, stopType, stopPurpose: 'STANDARD' },
      select: {
        loadId: true,
        sequence: true,
        appointmentDatetime: true,
        stopType: true,
        stopPurpose: true,
      },
    });
    const byLoad = new Map<string, StopDateRow[]>();
    for (const s of stops) {
      const list = byLoad.get(s.loadId) ?? [];
      list.push(s);
      byLoad.set(s.loadId, list);
    }
    const result = new Map<string, Date | null>();
    for (const id of loadIds) {
      result.set(id, pickStopDate(byLoad.get(id) ?? [], stopType));
    }
    return result;
  }

  async search(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: LoadSearchFilters,
    pagination: LoadSearchPagination,
  ): Promise<LoadSearchResult> {
    const { page, pageSize } = pagination;

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const where = this.buildWhere(organizationId, filters);
      const total = await tx.load.count({ where });

      // Load Search shares the LoadSummary contract with the Dispatch
      // Board's `GET /loads` (LoadService.list) — same narrowed
      // dispatchRecord.sourceDriver relation (firstName/lastName only,
      // never the full Driver row), reused across all three sort
      // branches below so every returned row carries `assignedDriverName`.
      let items: (Load & {
        stops: unknown[];
        dispatchRecord: {
          driverName: string | null;
          sourceDriver: { firstName: string; lastName: string } | null;
        } | null;
      })[];

      if (filters.sort === 'pickupDate' || filters.sort === 'deliveryDate') {
        const idRows = await tx.load.findMany({ where, select: { id: true } });
        const ids = idRows.map((r) => r.id);
        const stopType = filters.sort === 'pickupDate' ? 'PICKUP' : 'DELIVERY';
        const dateByLoad = await this.deriveSortDates(tx, ids, stopType);
        const direction = filters.sortDirection ?? 'asc';

        const sortedIds = [...ids].sort((a, b) => {
          const da = dateByLoad.get(a) ?? null;
          const db = dateByLoad.get(b) ?? null;
          if (da === null && db === null) return 0;
          if (da === null) return 1; // nulls last regardless of direction
          if (db === null) return -1;
          const diff = da.getTime() - db.getTime();
          return direction === 'asc' ? diff : -diff;
        });

        const pageIds = sortedIds.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
        const fetched = await tx.load.findMany({
          where: { id: { in: pageIds } },
          include: {
            stops: true,
            dispatchRecord: {
              include: { sourceDriver: { select: { firstName: true, lastName: true } } },
            },
          },
        });
        const byId = new Map(fetched.map((l) => [l.id, l]));
        items = pageIds.map((id) => byId.get(id)).filter((l): l is (typeof fetched)[number] => !!l);
      } else if (filters.sort === 'loadNumber') {
        items = await tx.load.findMany({
          where,
          include: {
            stops: true,
            dispatchRecord: {
              include: { sourceDriver: { select: { firstName: true, lastName: true } } },
            },
          },
          orderBy: { loadNumber: filters.sortDirection ?? 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      } else {
        items = await tx.load.findMany({
          where,
          include: {
            stops: true,
            dispatchRecord: {
              include: { sourceDriver: { select: { firstName: true, lastName: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      }

      // Same precedence as LoadService.list(): live sourceDriver name wins
      // over the DispatchRecord.driverName snapshot wins over null. Only
      // the resolved string is returned — dispatchRecord itself is
      // stripped here, never forwarded to the client.
      const withDriverName = items.map((item) => {
        const { dispatchRecord, ...rest } = item;
        const assignedDriverName = dispatchRecord
          ? dispatchRecord.sourceDriver
            ? `${dispatchRecord.sourceDriver.firstName} ${dispatchRecord.sourceDriver.lastName}`
            : dispatchRecord.driverName
          : null;
        return { ...rest, assignedDriverName };
      });

      return {
        items: shapeFinancialFieldsList(withDriverName, actingRoles, actingUserId),
        total,
        page,
        pageSize,
      };
    });
  }

  /**
   * Decision #7 — export must include every matching row, not just the
   * current page, so (unlike `search`) this always materializes the full
   * filtered set with its Stops. That full-materialization cost is the
   * export requirement itself, not the interactive-sort memory concern
   * `search` above was built to avoid.
   */
  async exportCsv(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: LoadSearchFilters,
  ): Promise<string> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const where = this.buildWhere(organizationId, filters);
      const loads = await tx.load.findMany({
        where,
        include: {
          stops: true,
          customer: true,
          assignedCarrier: true,
          assignedDispatcher: true,
        },
        orderBy:
          filters.sort === 'loadNumber'
            ? { loadNumber: filters.sortDirection ?? 'asc' }
            : { createdAt: 'desc' },
      });

      if (filters.sort === 'pickupDate' || filters.sort === 'deliveryDate') {
        const stopType = filters.sort === 'pickupDate' ? 'PICKUP' : 'DELIVERY';
        const direction = filters.sortDirection ?? 'asc';
        loads.sort((a, b) => {
          const da = pickStopDate(a.stops, stopType);
          const db = pickStopDate(b.stops, stopType);
          if (da === null && db === null) return 0;
          if (da === null) return 1;
          if (db === null) return -1;
          const diff = da.getTime() - db.getTime();
          return direction === 'asc' ? diff : -diff;
        });
      }

      const shaped = shapeFinancialFieldsList(loads, actingRoles, actingUserId);

      const rows = shaped.map((l) => {
        const pickups = l.stops
          .filter((s) => s.stopType === 'PICKUP' && s.stopPurpose === 'STANDARD')
          .sort((a, b) => a.sequence - b.sequence);
        const deliveries = l.stops
          .filter((s) => s.stopType === 'DELIVERY' && s.stopPurpose === 'STANDARD')
          .sort((a, b) => a.sequence - b.sequence);
        const origin = pickups[0];
        const destination = deliveries[deliveries.length - 1];
        const lane =
          origin && destination
            ? `${origin.city}, ${origin.state} → ${destination.city}, ${destination.state}`
            : '';
        const pickupDate = pickStopDate(l.stops, 'PICKUP');
        const deliveryDate = pickStopDate(l.stops, 'DELIVERY');

        return [
          l.loadNumber,
          l.customer?.legalName ?? '',
          l.status,
          l.riskStatus,
          l.assignedCarrier?.legalName ?? '',
          l.assignedDispatcher?.name ?? '',
          lane,
          pickupDate ? pickupDate.toISOString() : '',
          deliveryDate ? deliveryDate.toISOString() : '',
          l.equipmentType,
          l.customerRate != null ? String(l.customerRate) : '',
          l.carrierRate != null ? String(l.carrierRate) : '',
        ];
      });

      return toCsv([CSV_HEADER, ...rows]);
    });
  }
}
