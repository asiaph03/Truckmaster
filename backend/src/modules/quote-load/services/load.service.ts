import { Injectable } from '@nestjs/common';
import {
  BookingSource,
  Customer,
  EquipmentType,
  Load,
  MembershipRoleName,
  Prisma,
  RateSource,
  StopType,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { OrganizationSequenceService } from '../../identity/services/organization-sequence.service';
import { RateAgreementMatchingService } from './rate-agreement-matching.service';
import { shapeFinancialFields, shapeFinancialFieldsList } from './financial-field-shaping';
import { CreateLoadDto } from '../dto/create-load.dto';
import { UpdateLoadReferenceNumbersDto } from '../dto/update-load-reference-numbers.dto';
import { BusinessRuleError, NotFoundError } from '../../../common/errors/app-error';

/**
 * Deliberately looser than LoadStopInputDto (which requires addressLine1
 * — appropriate for Direct-to-Booked client input, §4.8): Quote
 * conversion (§4.7) synthesizes stops server-side from QuoteStop rows,
 * which never captured a street address (§4.2, lane-level only), so
 * addressLine1 is optional here. A validated LoadStopInputDto[] already
 * satisfies this shape structurally.
 */
export interface LoadStopCreateInput {
  sequence: number;
  stopType: StopType;
  customerLocationId?: string;
  addressLine1?: string;
  city: string;
  state: string;
  zip: string;
  appointmentDatetime?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface CreateFromBookingParams {
  customerId: string;
  bookingSource: BookingSource;
  quoteId: string | null;
  equipmentType: EquipmentType;
  customerRate: string;
  rateSource: RateSource;
  rateAgreementId: string | null;
  stops: LoadStopCreateInput[];
  customerPoNumber?: string;
  bolNumber?: string;
  pickupNumber?: string;
  customerReferenceNumber?: string;
  actingUserId: string;
  auditAction: string;
}

@Injectable()
export class LoadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: OrganizationSequenceService,
    private readonly rateAgreementMatching: RateAgreementMatchingService,
  ) {}

  async findById(
    organizationId: string,
    id: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    const load = await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const found = await tx.load.findFirst({
        where: { id, organizationId },
        // Phase 4 addition — sourcingAttempts/dispatchRecord/checkCalls are
        // purely additive read-side includes (new Phase 4 relations); no
        // Phase 3 business rule changes.
        include: { stops: true, sourcingAttempts: true, dispatchRecord: true, checkCalls: true },
      });
      if (!found) return null;

      // Phase 5 addition — Document has no native Prisma relation to Stop
      // (deliberately polymorphic, DATABASE_DESIGN.md §7), so per-stop POD
      // presence is queried separately rather than via a relational
      // include, then merged onto each stop as `hasPod`. Only CLEAN,
      // current-version POD documents count (mirrors
      // LoadPodStatusService.recalculatePodStatus's own query exactly).
      const deliveryStopIds = found.stops.filter((s) => s.stopType === 'DELIVERY').map((s) => s.id);
      const podDocuments = await tx.document.findMany({
        where: {
          organizationId,
          entityType: 'STOP',
          entityId: { in: deliveryStopIds },
          isCurrentVersion: true,
          scanStatus: 'CLEAN',
          documentType: { code: 'POD' },
        },
        select: { entityId: true },
      });
      const stopIdsWithPod = new Set(podDocuments.map((d) => d.entityId));

      return {
        ...found,
        stops: found.stops.map((s) => ({ ...s, hasPod: stopIdsWithPod.has(s.id) })),
      };
    });
    if (!load) throw new NotFoundError('Load not found.');
    return shapeFinancialFields(load, actingRoles, actingUserId);
  }

  async list(
    organizationId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
    filters: { status?: string; customerId?: string } = {},
  ) {
    const loads = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: {
          organizationId,
          ...(filters.status ? { status: filters.status as Load['status'] } : {}),
          ...(filters.customerId ? { customerId: filters.customerId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return shapeFinancialFieldsList(loads, actingRoles, actingUserId);
  }

  /**
   * Workflow 4 §4.3's Booking-path column — stricter than the Quote path:
   * PROSPECT blocked (must be Active first), ACTIVE allowed, INACTIVE
   * requires an explicit, audited override, BLOCKED blocked entirely with
   * no override. Shared by `createDirect` (below) and
   * `QuoteService.convert` (§4.7 re-runs this same check).
   */
  async assertCustomerAllowsBooking(
    tx: Prisma.TransactionClient,
    organizationId: string,
    customer: Customer,
    confirmInactiveOverride: boolean | undefined,
    actingUserId: string,
  ): Promise<void> {
    if (customer.status === 'BLOCKED') {
      throw new BusinessRuleError('Customer is Blocked — no new Loads can be created.');
    }
    if (customer.status === 'PROSPECT') {
      throw new BusinessRuleError('Customer must be Active before a Load can be Booked.');
    }
    if (customer.status === 'INACTIVE') {
      if (!confirmInactiveOverride) {
        throw new BusinessRuleError(
          'Customer is Inactive — booking requires an explicit override confirmation.',
        );
      }
      await this.audit.record(tx, {
        organizationId,
        action: 'Inactive Customer Booking Override',
        entityType: 'Customer',
        entityId: customer.id,
        actorUserId: actingUserId,
      });
    }
  }

  /**
   * Shared Load-row creation for both booking paths (§4.7 Quote
   * conversion, §4.8 Direct-to-Booked) — numbering (§4.9,
   * "only at the moment a transaction becomes BOOKED"), the Load row +
   * its Stops, and the audit event (action text supplied by the caller,
   * since the two paths use different action names). Runs inside the
   * caller's already-open transaction — never opens its own, since
   * conversion must commit the Quote and Load changes atomically together.
   */
  async createFromBooking(
    tx: Prisma.TransactionClient,
    organizationId: string,
    params: CreateFromBookingParams,
  ): Promise<Load> {
    const nextNumber = await this.sequences.getNextNumber(tx, organizationId, 'LOAD');
    const loadNumber = this.sequences.format('LOAD', nextNumber);

    const load = await tx.load.create({
      data: {
        organizationId,
        loadNumber,
        customerId: params.customerId,
        bookingSource: params.bookingSource,
        quoteId: params.quoteId,
        status: 'BOOKED',
        equipmentType: params.equipmentType,
        customerRate: params.customerRate,
        rateSource: params.rateSource,
        rateAgreementId: params.rateAgreementId,
        customerPoNumber: params.customerPoNumber,
        bolNumber: params.bolNumber,
        pickupNumber: params.pickupNumber,
        customerReferenceNumber: params.customerReferenceNumber,
        createdByUserId: params.actingUserId,
        // dispatcher assignment is deliberately out of scope here (§4.11)
        // — assignedDispatcherId stays at its schema default (null).
        stops: {
          create: params.stops.map((stop) => ({
            organizationId,
            sequence: stop.sequence,
            stopType: stop.stopType,
            customerLocationId: stop.customerLocationId,
            addressLine1: stop.addressLine1,
            city: stop.city,
            state: stop.state,
            zip: stop.zip,
            appointmentDatetime: stop.appointmentDatetime
              ? new Date(stop.appointmentDatetime)
              : undefined,
            contactName: stop.contactName,
            contactPhone: stop.contactPhone,
            notes: stop.notes,
          })),
        },
      },
      include: { stops: true },
    });

    await this.audit.record(tx, {
      organizationId,
      action: params.auditAction,
      entityType: 'Load',
      entityId: load.id,
      newValue: {
        loadNumber: load.loadNumber,
        customerId: load.customerId,
        bookingSource: load.bookingSource,
        customerRate: load.customerRate.toString(),
        rateSource: load.rateSource,
      },
      actorUserId: params.actingUserId,
    });

    return load;
  }

  /** Workflow 4 §4.8 — Direct-to-Booked creation (no Quote). */
  async createDirect(
    organizationId: string,
    dto: CreateLoadDto,
    actingUserId: string,
  ): Promise<Load> {
    const firstPickup = [...dto.stops]
      .filter((s) => s.stopType === 'PICKUP')
      .sort((a, b) => a.sequence - b.sequence)[0];
    const lastDelivery = [...dto.stops]
      .filter((s) => s.stopType === 'DELIVERY')
      .sort((a, b) => b.sequence - a.sequence)[0];
    if (!firstPickup || !lastDelivery) {
      throw new BusinessRuleError('At least one pickup stop and one delivery stop are required.');
    }

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: dto.customerId, organizationId },
      });
      if (!customer) throw new NotFoundError('Customer not found.');
      await this.assertCustomerAllowsBooking(
        tx,
        organizationId,
        customer,
        dto.confirmInactiveCustomerOverride,
        actingUserId,
      );

      const { rateAgreementId, rateSource } = await this.rateAgreementMatching.resolveRate(
        tx,
        organizationId,
        dto.customerId,
        firstPickup.city,
        firstPickup.state,
        lastDelivery.city,
        lastDelivery.state,
        dto.equipmentType,
        dto.customerRate,
      );

      return this.createFromBooking(tx, organizationId, {
        customerId: dto.customerId,
        bookingSource: 'DIRECT',
        quoteId: null,
        equipmentType: dto.equipmentType,
        customerRate: dto.customerRate,
        rateSource,
        rateAgreementId,
        stops: dto.stops,
        customerPoNumber: dto.customerPoNumber,
        bolNumber: dto.bolNumber,
        pickupNumber: dto.pickupNumber,
        customerReferenceNumber: dto.customerReferenceNumber,
        actingUserId,
        auditAction: 'Load Booked Directly (No Quote)',
      });
    });
  }

  /** Workflow 4 §4.10 — addable/updatable at any time, never required to reach BOOKED. */
  async updateReferenceNumbers(
    organizationId: string,
    id: string,
    dto: UpdateLoadReferenceNumbersDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const existing = await tx.load.findFirst({ where: { id, organizationId } });
      if (!existing) throw new NotFoundError('Load not found.');

      const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
      for (const [field, newValue] of Object.entries(dto)) {
        if (newValue === undefined) continue;
        const previousValue = (existing as unknown as Record<string, unknown>)[field];
        if (previousValue !== newValue) {
          fieldChanges.push({ field, previous: previousValue, new: newValue });
        }
      }

      const updated = await tx.load.update({ where: { id }, data: { ...dto } });

      if (fieldChanges.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Reference Number Added/Updated',
          entityType: 'Load',
          entityId: id,
          previousValue: { field_changes: fieldChanges },
          actorUserId: actingUserId,
        });
      }

      return updated;
    });
  }
}
