import { Injectable } from '@nestjs/common';
import { Load, Prisma, Stop } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { parseBusinessDateTime } from '../../../common/timezone/business-timezone';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';
import { LoadStatusDerivationService } from './load-status-derivation.service';
import { DispatchLoadDto } from '../dto/dispatch-load.dto';
import { UpdateDispatchDto } from '../dto/update-dispatch.dto';
import { StopTimestampDto } from '../dto/stop-timestamp.dto';
import { RescheduleStopDto } from '../dto/reschedule-stop.dto';
import { UpdateStopsDto } from '../dto/update-stops.dto';
import { LogCheckCallDto } from '../dto/log-check-call.dto';
import { SetRiskStatusDto } from '../dto/set-risk-status.dto';
import { AssignDispatcherDto } from '../dto/assign-dispatcher.dto';
import {
  BusinessRuleError,
  EligibilityError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

const POST_DISPATCH_STATUSES: Load['status'][] = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'];

const LOAD_STATUS_ADVANCED_ACTION: Partial<Record<Load['status'], string>> = {
  PICKUP: 'Load Status Advanced — Pickup',
  IN_TRANSIT: 'Load Status Advanced — In Transit',
  DELIVERED: 'Load Status Advanced — Delivered',
};

@Injectable()
export class DispatchTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierEligibility: CarrierEligibilityService,
    private readonly statusDerivation: LoadStatusDerivationService,
  ) {}

  /**
   * Workflow 6 §6.1 — the full Dispatch gate, re-validated here (not
   * trusted from the client), plus §6.2's driver/equipment snapshotting.
   */
  async dispatch(
    organizationId: string,
    loadId: string,
    dto: DispatchLoadDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (load.status !== 'RATE_CONFIRMATION') {
        throw new InvalidTransitionError(
          'A Load can only be Dispatched once it has reached Rate Confirmation.',
        );
      }
      // load.status === RATE_CONFIRMATION is only reachable with an
      // assigned carrier + carrier rate on record (Workflow 5's own
      // sequence) — re-checked defensively rather than assumed.
      if (!load.assignedCarrierId || load.carrierRate === null) {
        throw new BusinessRuleError('Carrier and carrier rate must be on record.');
      }

      const { eligible, reasons } = await this.carrierEligibility.recalculate(
        tx,
        organizationId,
        load.assignedCarrierId,
      );
      if (!eligible) {
        throw new EligibilityError('The assigned carrier is no longer eligible for assignment.', {
          reasons,
        });
      }

      const rateConfirmationDoc = await tx.document.findFirst({
        where: {
          organizationId,
          entityType: 'LOAD',
          entityId: loadId,
          isCurrentVersion: true,
          documentType: { code: 'RATE_CONFIRMATION' },
        },
      });
      if (!rateConfirmationDoc) {
        throw new InvalidTransitionError('No Rate Confirmation is on file for this Load.');
      }

      await tx.dispatchRecord.create({
        data: {
          loadId,
          organizationId,
          driverName: dto.driverName,
          driverPhone: dto.driverPhone,
          truckNumber: dto.truckNumber,
          trailerNumber: dto.trailerNumber,
          sourceDriverId: dto.sourceDriverId,
          sourceTruckId: dto.sourceTruckId,
          sourceTrailerId: dto.sourceTrailerId,
          dispatchedByUserId: actingUserId,
        },
      });

      const updated = await tx.load.update({
        where: { id: loadId },
        data: { status: 'DISPATCHED' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Load Dispatched',
        entityType: 'Load',
        entityId: loadId,
        newValue: {
          driverName: dto.driverName,
          driverPhone: dto.driverPhone,
          truckNumber: dto.truckNumber,
          trailerNumber: dto.trailerNumber,
        },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /** Workflow 6 §6.9 — post-dispatch editing, field-diff audited, history via AuditLog only. */
  async updateDispatch(
    organizationId: string,
    loadId: string,
    dto: UpdateDispatchDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!POST_DISPATCH_STATUSES.includes(load.status)) {
        throw new InvalidTransitionError('This Load has not been Dispatched yet.');
      }

      const existing = await tx.dispatchRecord.findFirst({ where: { loadId, organizationId } });
      if (!existing) throw new NotFoundError('Dispatch record not found.');

      const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
      for (const [field, newValue] of Object.entries(dto)) {
        if (newValue === undefined) continue;
        const previousValue = (existing as unknown as Record<string, unknown>)[field];
        if (previousValue !== newValue) {
          fieldChanges.push({ field, previous: previousValue, new: newValue });
        }
      }

      const updated = await tx.dispatchRecord.update({
        where: { loadId },
        data: { ...dto },
      });

      if (fieldChanges.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Dispatch Information Changed',
          entityType: 'Load',
          entityId: loadId,
          previousValue: { field_changes: fieldChanges },
          actorUserId: actingUserId,
        });
      }

      return updated;
    });
  }

  private async reEvaluateLoadStatus(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: Load,
  ): Promise<Load> {
    const stops = await tx.stop.findMany({ where: { loadId: load.id, organizationId } });
    const nextStatus = this.statusDerivation.deriveLoadStatus(
      load.status,
      stops.map((s) => ({ stopType: s.stopType, status: s.status, sequence: s.sequence })),
    );
    if (nextStatus === load.status) return load;

    const updated = await tx.load.update({ where: { id: load.id }, data: { status: nextStatus } });

    const action = LOAD_STATUS_ADVANCED_ACTION[nextStatus];
    if (action) {
      await this.audit.record(tx, {
        organizationId,
        action,
        entityType: 'Load',
        entityId: load.id,
        previousValue: { status: load.status },
        newValue: { status: nextStatus },
        actorType: 'SYSTEM',
      });
    }
    return updated;
  }

  /** Workflow 6 §6.4 — Stop PENDING -> ARRIVED, then re-derives Load status. */
  async recordArrival(
    organizationId: string,
    loadId: string,
    sequence: number,
    dto: StopTimestampDto,
    actingUserId: string,
  ): Promise<{ stop: Stop; load: Load }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!POST_DISPATCH_STATUSES.includes(load.status)) {
        throw new InvalidTransitionError('This Load has not been Dispatched yet.');
      }

      const stop = await tx.stop.findFirst({ where: { loadId, organizationId, sequence } });
      if (!stop) throw new NotFoundError('Stop not found.');
      if (stop.status !== 'PENDING') {
        throw new InvalidTransitionError('This Stop has already recorded an arrival.');
      }

      const dispatchRecord = await tx.dispatchRecord.findFirst({
        where: { loadId, organizationId },
      });
      const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();
      if (dispatchRecord && timestamp < dispatchRecord.dispatchedAt) {
        throw new BusinessRuleError('Arrival time cannot be before the Load was Dispatched.');
      }

      const updatedStop = await tx.stop.update({
        where: { id: stop.id },
        data: { actualArrival: timestamp, status: 'ARRIVED' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Stop Arrival Recorded',
        entityType: 'Stop',
        entityId: stop.id,
        newValue: { sequence: stop.sequence, actualArrival: timestamp },
        actorUserId: actingUserId,
      });

      const updatedLoad = await this.reEvaluateLoadStatus(tx, organizationId, load);
      return { stop: updatedStop, load: updatedLoad };
    });
  }

  /** Workflow 6 §6.5 — Stop ARRIVED -> COMPLETED, then re-derives Load status. */
  async recordDeparture(
    organizationId: string,
    loadId: string,
    sequence: number,
    dto: StopTimestampDto,
    actingUserId: string,
  ): Promise<{ stop: Stop; load: Load }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!POST_DISPATCH_STATUSES.includes(load.status)) {
        throw new InvalidTransitionError('This Load has not been Dispatched yet.');
      }

      const stop = await tx.stop.findFirst({ where: { loadId, organizationId, sequence } });
      if (!stop) throw new NotFoundError('Stop not found.');
      if (stop.status !== 'ARRIVED') {
        throw new InvalidTransitionError('This Stop must record an arrival before a departure.');
      }

      const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();
      if (stop.actualArrival && timestamp < stop.actualArrival) {
        throw new BusinessRuleError('Departure time cannot be before the recorded arrival time.');
      }

      const updatedStop = await tx.stop.update({
        where: { id: stop.id },
        data: { actualDeparture: timestamp, status: 'COMPLETED' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Stop Completed',
        entityType: 'Stop',
        entityId: stop.id,
        newValue: { sequence: stop.sequence, actualDeparture: timestamp },
        actorUserId: actingUserId,
      });

      const updatedLoad = await this.reEvaluateLoadStatus(tx, organizationId, load);
      return { stop: updatedStop, load: updatedLoad };
    });
  }

  /**
   * UI_UX_DESIGN.md §5.4.3 Decision DB-C-4 (Frontend Phase 6 approved
   * gap-fix) — Calendar drag-to-reschedule. Updates
   * `Stop.appointmentDatetime` only, never `Stop.status` or
   * `Load.status` — a pure reschedule, not a general stop-editing
   * endpoint. Re-validated here, not trusted from the client:
   * restricted to a still-`PENDING` stop (an `ARRIVED`/`COMPLETED` stop
   * has already happened and isn't reschedulable) on a Load that hasn't
   * reached `DELIVERED`/`CLOSED`. The two checks are not redundant —
   * `LoadStatusDerivationService.deriveLoadStatus` only requires every
   * Pickup plus the *final* Delivery stop to be COMPLETED for
   * `DELIVERED`, so an earlier Delivery stop on a multi-delivery Load
   * can still be PENDING after the Load itself reads DELIVERED.
   */
  async rescheduleStop(
    organizationId: string,
    loadId: string,
    sequence: number,
    dto: RescheduleStopDto,
    actingUserId: string,
  ): Promise<Stop> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (load.status === 'DELIVERED' || load.status === 'CLOSED') {
        throw new InvalidTransitionError(
          'Stops on a Delivered or Closed Load cannot be rescheduled.',
        );
      }

      const stop = await tx.stop.findFirst({ where: { loadId, organizationId, sequence } });
      if (!stop) throw new NotFoundError('Stop not found.');
      if (stop.status !== 'PENDING') {
        throw new InvalidTransitionError('Only a Pending stop can be rescheduled.');
      }

      const previousAppointment = stop.appointmentDatetime;
      const newAppointment = parseBusinessDateTime(dto.appointmentDatetime);

      const updatedStop = await tx.stop.update({
        where: { id: stop.id },
        data: { appointmentDatetime: newAppointment },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Stop Rescheduled',
        entityType: 'Stop',
        entityId: stop.id,
        previousValue: { sequence: stop.sequence, appointmentDatetime: previousAppointment },
        newValue: { sequence: stop.sequence, appointmentDatetime: newAppointment },
        actorUserId: actingUserId,
      });

      return updatedStop;
    });
  }

  /**
   * Load Detail's Edit Stops action — corrects existing stops' descriptive
   * fields (Company Name, address, contact, notes, appointment, type)
   * after a Load has already been created. No load-status gate, matching
   * `updateReferenceNumbers`'s own "post-creation correction" precedent —
   * this is a data-correction action, not a dispatch-tracking transition,
   * and never touches `Stop.status`/`actualArrival`/`actualDeparture`
   * (those stay owned by `recordArrival`/`recordDeparture` above).
   *
   * The whole batch runs inside one transaction: if any item's `sequence`
   * doesn't resolve to a Stop on *this* Load/organization, the thrown
   * `NotFoundError` rolls back every `tx.stop.update` already applied
   * earlier in the same loop (Prisma's `$transaction` semantics, via
   * `withTenantTransaction`) — so a batch can never partially apply.
   * `sequence` itself is only ever read (to find the target row), never
   * written — stop ordering is untouched by construction, and no stop is
   * added, removed, or recreated; every write is `tx.stop.update({
   * where: { id: stop.id }, ... })` against the row `findFirst` already
   * proved belongs to this Load and organization.
   *
   * `companyName` is written directly from `item.companyName` — never
   * derived from `load.customerId`, `stop.customerLocationId`, or any
   * joined Customer/CustomerLocation/Carrier row.
   */
  async updateStops(
    organizationId: string,
    loadId: string,
    dto: UpdateStopsDto,
    actingUserId: string,
  ): Promise<{ stops: Stop[]; load: Load }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      const updatedStops: Stop[] = [];

      for (const item of dto.stops) {
        const stop = await tx.stop.findFirst({
          where: { loadId, organizationId, sequence: item.sequence },
        });
        if (!stop) throw new NotFoundError(`Stop ${item.sequence} not found.`);

        const nextValues = {
          stopType: item.stopType,
          companyName: item.companyName,
          addressLine1: item.addressLine1,
          city: item.city,
          state: item.state,
          zip: item.zip,
          appointmentDatetime: item.appointmentDatetime
            ? parseBusinessDateTime(item.appointmentDatetime)
            : null,
          contactName: item.contactName ?? null,
          contactPhone: item.contactPhone ?? null,
          notes: item.notes ?? null,
        };

        const fieldChanges: { field: string; previous: unknown; new: unknown }[] = [];
        for (const [field, newValue] of Object.entries(nextValues)) {
          const previousValue = (stop as unknown as Record<string, unknown>)[field];
          const changed =
            newValue instanceof Date
              ? previousValue === null ||
                previousValue === undefined ||
                new Date(previousValue as string).getTime() !== newValue.getTime()
              : previousValue !== newValue;
          if (changed) {
            fieldChanges.push({ field, previous: previousValue, new: newValue });
          }
        }

        const updatedStop = await tx.stop.update({
          where: { id: stop.id },
          data: nextValues,
        });
        updatedStops.push(updatedStop);

        if (fieldChanges.length > 0) {
          await this.audit.record(tx, {
            organizationId,
            action: 'Stop Details Updated',
            entityType: 'Stop',
            entityId: stop.id,
            previousValue: { sequence: stop.sequence, field_changes: fieldChanges },
            actorUserId: actingUserId,
          });
        }
      }

      const updatedLoad = await this.reEvaluateLoadStatus(tx, organizationId, load);
      return { stops: updatedStops, load: updatedLoad };
    });
  }

  /** Workflow 6 §6.7 — gated to DISPATCHED or later, updates current location/ETA. */
  async logCheckCall(
    organizationId: string,
    loadId: string,
    dto: LogCheckCallDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!POST_DISPATCH_STATUSES.includes(load.status)) {
        throw new BusinessRuleError('A Check Call cannot be logged before the Load is Dispatched.');
      }

      const checkCall = await tx.checkCall.create({
        data: {
          organizationId,
          loadId,
          loggedByUserId: actingUserId,
          occurredAt: dto.occurredAt ? parseBusinessDateTime(dto.occurredAt) : new Date(),
          contactMethod: dto.contactMethod,
          personContacted: dto.personContacted,
          locationCity: dto.locationCity,
          locationState: dto.locationState,
          locationZip: dto.locationZip,
          eta: dto.eta ? parseBusinessDateTime(dto.eta) : undefined,
          onTimeStatus: dto.onTimeStatus,
          notes: dto.notes,
        },
      });

      const updatedLoad = await tx.load.update({
        where: { id: loadId },
        data: {
          currentLocationCity: dto.locationCity ?? load.currentLocationCity,
          currentLocationState: dto.locationState ?? load.currentLocationState,
          currentLocationZip: dto.locationZip ?? load.currentLocationZip,
          currentLocationUpdatedAt: new Date(),
          currentEta: dto.eta ? parseBusinessDateTime(dto.eta) : load.currentEta,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Check Call Logged',
        entityType: 'Load',
        entityId: loadId,
        newValue: { checkCallId: checkCall.id, onTimeStatus: dto.onTimeStatus },
        actorUserId: actingUserId,
      });

      return { checkCall, load: updatedLoad };
    });
  }

  /** Workflow 6 §6.8 — independent of Load.status, gated to DISPATCHED or later. */
  async setRiskStatus(
    organizationId: string,
    loadId: string,
    dto: SetRiskStatusDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (!POST_DISPATCH_STATUSES.includes(load.status)) {
        throw new BusinessRuleError('Risk Status cannot be set before the Load is Dispatched.');
      }
      if (dto.riskStatus !== 'NORMAL' && !dto.riskReason) {
        throw new BusinessRuleError('A reason is required when Risk Status is not Normal.');
      }

      const updated = await tx.load.update({
        where: { id: loadId },
        data: {
          riskStatus: dto.riskStatus,
          riskReason: dto.riskStatus === 'NORMAL' ? null : dto.riskReason,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Risk Status Changed',
        entityType: 'Load',
        entityId: loadId,
        previousValue: { riskStatus: load.riskStatus, riskReason: load.riskReason },
        newValue: { riskStatus: dto.riskStatus, riskReason: updated.riskReason },
        reason: dto.riskReason,
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * Independent action (Workflow 4 §4.11 / Workflow 5 §5.8 — approved
   * Phase 4 decision): assigns or reassigns the Load's dispatcher. Never a
   * prerequisite for any other Phase 4 transition, and carries no status
   * gate of its own.
   */
  async assignDispatcher(
    organizationId: string,
    loadId: string,
    dto: AssignDispatcherDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      const membership = await tx.organizationMembership.findFirst({
        where: { organizationId, userId: dto.dispatcherUserId, status: 'ACTIVE' },
      });
      if (!membership) {
        throw new NotFoundError('This user is not an active member of the organization.');
      }

      if (load.assignedDispatcherId === dto.dispatcherUserId) {
        return load;
      }

      const isReassignment = load.assignedDispatcherId !== null;

      const updated = await tx.load.update({
        where: { id: loadId },
        data: { assignedDispatcherId: dto.dispatcherUserId },
      });

      await this.audit.record(tx, {
        organizationId,
        action: isReassignment ? 'Dispatcher Reassigned' : 'Dispatcher Assigned',
        entityType: 'Load',
        entityId: loadId,
        previousValue: { assignedDispatcherId: load.assignedDispatcherId },
        newValue: { assignedDispatcherId: dto.dispatcherUserId },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }
}
