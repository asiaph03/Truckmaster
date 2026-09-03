import { Inject, Injectable } from '@nestjs/common';
import { Load, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';
import {
  EMAIL_QUEUE,
  EmailJobData,
  EMAIL_JOB_OPTIONS,
} from '../../../common/email/email-queue.constants';
import { LogSourcingAttemptDto } from '../dto/log-sourcing-attempt.dto';
import { AssignCarrierDto } from '../dto/assign-carrier.dto';
import { CarrierRejectedDto } from '../dto/carrier-rejected.dto';
import { GenerateRateConfirmationDto } from '../dto/generate-rate-confirmation.dto';
import { SendDriverDispatchEmailDto } from '../dto/send-driver-dispatch-email.dto';
import {
  BusinessRuleError,
  EligibilityError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';
import {
  RATE_CONFIRMATION_QUEUE,
  RATE_CONFIRMATION_JOB_OPTIONS,
  RateConfirmationJobData,
} from './rate-confirmation.constants';
import {
  buildDriverDispatchMessage,
  DriverDispatchMessage,
} from '../utils/driver-dispatch-message';
import { isDocumentConsumable } from '../../document/services/document-consumption';

const RATE_CONFIRMATION_DOCUMENT_TYPE_CODE = 'RATE_CONFIRMATION';

export interface DriverDispatchEmailPreview {
  /** null when no email is on file for the assigned driver — the frontend must then collect a one-time manual override. */
  recipientEmail: string | null;
  subject: string;
  body: string;
  attachmentAvailable: boolean;
  attachmentFileName: string | null;
}

@Injectable()
export class CarrierSourcingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly carrierEligibility: CarrierEligibilityService,
    @Inject(EMAIL_QUEUE) private readonly emailQueue: Queue,
    @Inject(RATE_CONFIRMATION_QUEUE) private readonly rateConfirmationQueue: Queue,
  ) {}

  /** Workflow 5 §5.1 — explicit, user-initiated. Never automatic. */
  async beginSourcing(organizationId: string, loadId: string, actingUserId: string): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (load.status !== 'BOOKED') {
        throw new InvalidTransitionError('Only a BOOKED load can enter Carrier Sourcing.');
      }

      const updated = await tx.load.update({
        where: { id: loadId },
        data: { status: 'CARRIER_SOURCING' },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Load Entered Carrier Sourcing',
        entityType: 'Load',
        entityId: loadId,
        previousValue: { status: 'BOOKED' },
        newValue: { status: 'CARRIER_SOURCING' },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * Workflow 5 §5.5 — optional, cumulative sourcing-contact history.
   * Always creates a new row; never overwrites a prior attempt.
   */
  async logSourcingAttempt(
    organizationId: string,
    loadId: string,
    dto: LogSourcingAttemptDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      const carrier = await tx.carrier.findFirst({
        where: { id: dto.carrierId, organizationId },
      });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const attempt = await tx.carrierSourcingAttempt.create({
        data: {
          organizationId,
          loadId,
          carrierId: dto.carrierId,
          carrierRate: dto.carrierRate,
          outcome: dto.outcome,
          loggedByUserId: actingUserId,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Sourcing Attempt Logged',
        entityType: 'Load',
        entityId: loadId,
        newValue: {
          carrierId: dto.carrierId,
          outcome: dto.outcome,
          carrierRate: dto.carrierRate ?? null,
        },
        actorUserId: actingUserId,
      });

      return attempt;
    });
  }

  /**
   * Phase 6 addition — DATABASE_DESIGN.md §14: "A LINEHAUL line item
   * (side=CARRIER, amount=Load.carrier_rate)... created automatically at
   * ...assignment time," matching TECHNICAL_ARCHITECTURE.md §5.2's
   * `assign-carrier` side-effects list exactly. Explicitly deferred when
   * Phase 4 was built (disclosed at the time — `ChargeLineItem` didn't
   * exist as a table yet), closed now that Phase 6 exists. Purely
   * additive — does not alter any other assignment behavior.
   */
  private async createOriginalCarrierLinehaulCharge(
    tx: Prisma.TransactionClient,
    organizationId: string,
    loadId: string,
    carrierRate: string,
    actingUserId: string,
  ): Promise<void> {
    const linehaulType = await tx.chargeTypeDefinition.findFirst({
      where: { code: 'LINEHAUL', OR: [{ organizationId }, { organizationId: null }] },
    });
    if (!linehaulType) return; // seed not applied — defensive, never expected in a real deploy

    await tx.chargeLineItem.create({
      data: {
        organizationId,
        loadId,
        side: 'CARRIER',
        chargeTypeId: linehaulType.id,
        unitRate: carrierRate,
        amount: carrierRate,
        source: 'ORIGINAL',
        createdByUserId: actingUserId,
      },
    });
  }

  /**
   * Workflow 5 §5.3/§5.4 — the hard, non-overridable eligibility gate,
   * re-validated live inside this transaction (never trusted from an
   * earlier read), then assignment itself.
   */
  async assignCarrier(
    organizationId: string,
    loadId: string,
    dto: AssignCarrierDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (load.status !== 'CARRIER_SOURCING') {
        throw new InvalidTransitionError(
          'A carrier can only be assigned to a load that is currently in Carrier Sourcing.',
        );
      }

      const carrier = await tx.carrier.findFirst({
        where: { id: dto.carrierId, organizationId },
      });
      if (!carrier) throw new NotFoundError('Carrier not found.');

      const { eligible, reasons } = await this.carrierEligibility.recalculate(
        tx,
        organizationId,
        dto.carrierId,
      );
      if (!eligible) {
        await this.audit.record(tx, {
          organizationId,
          action: 'Carrier Assignment Blocked — Ineligible',
          entityType: 'Load',
          entityId: loadId,
          newValue: { carrierId: dto.carrierId, reasons },
          actorType: 'SYSTEM',
        });
        throw new EligibilityError('This carrier is not eligible for assignment.', { reasons });
      }

      await tx.carrierSourcingAttempt.create({
        data: {
          organizationId,
          loadId,
          carrierId: dto.carrierId,
          carrierRate: dto.carrierRate,
          outcome: 'ASSIGNED',
          loggedByUserId: actingUserId,
        },
      });

      const updated = await tx.load.update({
        where: { id: loadId },
        data: {
          status: 'CARRIER_ASSIGNED',
          assignedCarrierId: dto.carrierId,
          carrierRate: dto.carrierRate,
        },
      });

      await this.createOriginalCarrierLinehaulCharge(
        tx,
        organizationId,
        loadId,
        dto.carrierRate,
        actingUserId,
      );

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Assigned',
        entityType: 'Load',
        entityId: loadId,
        newValue: { carrierId: dto.carrierId, carrierRate: dto.carrierRate },
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * Workflow 5 §5.6 — full sourcing history preserved (the existing
   * ASSIGNED attempt row is updated in place, never deleted), no cycle
   * limit.
   */
  async carrierRejected(
    organizationId: string,
    loadId: string,
    dto: CarrierRejectedDto,
    actingUserId: string,
  ): Promise<Load> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');
      if (load.status !== 'CARRIER_ASSIGNED') {
        throw new InvalidTransitionError(
          'Only a load with an active Carrier Assignment can record a Carrier Rejection.',
        );
      }

      const attempt = await tx.carrierSourcingAttempt.findFirst({
        where: {
          organizationId,
          loadId,
          carrierId: load.assignedCarrierId ?? undefined,
          outcome: 'ASSIGNED',
        },
        orderBy: { loggedAt: 'desc' },
      });
      if (attempt) {
        await tx.carrierSourcingAttempt.update({
          where: { id: attempt.id },
          data: { outcome: 'REJECTED_AFTER_ASSIGNMENT', rejectionReason: dto.reason },
        });
      }

      const previousCarrierId = load.assignedCarrierId;
      const previousCarrierRate = load.carrierRate;

      const updated = await tx.load.update({
        where: { id: loadId },
        data: { status: 'CARRIER_SOURCING', assignedCarrierId: null, carrierRate: null },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Carrier Rejected — Returned to Sourcing',
        entityType: 'Load',
        entityId: loadId,
        previousValue: {
          carrierId: previousCarrierId,
          carrierRate: previousCarrierRate?.toString() ?? null,
        },
        newValue: { reason: dto.reason },
        reason: dto.reason,
        actorUserId: actingUserId,
      });

      return updated;
    });
  }

  /**
   * Workflow 5 §5.7 — hard gate before Dispatch. Only Carrier + carrier
   * rate are required (driver/truck/trailer belong to Workflow 6). Creates
   * the Document row synchronously (system-generated, scanStatus=CLEAN —
   * malware scanning per Decision 10 applies to user-uploaded files;
   * nothing external touches this content), enqueues the async PDF-render
   * job after commit (mirroring DocumentService.confirmUpload's
   * commit-then-enqueue pattern), and transitions the Load.
   */
  async generateRateConfirmation(
    organizationId: string,
    loadId: string,
    dto: GenerateRateConfirmationDto,
    actingUserId: string,
  ): Promise<Load> {
    const { load, document, carrierEmail } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const existing = await tx.load.findFirst({
          where: { id: loadId, organizationId },
          include: { assignedCarrier: true },
        });
        if (!existing) throw new NotFoundError('Load not found.');
        if (existing.status !== 'CARRIER_ASSIGNED') {
          throw new InvalidTransitionError(
            'A Rate Confirmation can only be generated for a load with an active Carrier Assignment.',
          );
        }
        if (!existing.assignedCarrierId || existing.carrierRate === null) {
          throw new BusinessRuleError('Carrier and carrier rate must be on record.');
        }

        const documentType = await tx.documentTypeDefinition.findFirst({
          where: { code: 'RATE_CONFIRMATION', OR: [{ organizationId }, { organizationId: null }] },
        });
        if (!documentType) {
          throw new NotFoundError('Rate Confirmation document type is not configured.');
        }

        const created = await tx.document.create({
          data: {
            organizationId,
            entityType: 'LOAD',
            entityId: loadId,
            documentTypeId: documentType.id,
            fileStorageKey: '',
            fileName: `RateConfirmation-${existing.loadNumber}.pdf`,
            fileSizeBytes: 0,
            mimeType: 'application/pdf',
            versionNumber: 1,
            isCurrentVersion: true,
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanProvider: 'system-generated',
            reviewStatus: 'NOT_APPLICABLE',
            generationStatus: 'PENDING',
            uploadedByUserId: actingUserId,
          },
        });
        const withKey = await tx.document.update({
          where: { id: created.id },
          data: { fileStorageKey: this.storage.buildDocumentKey(organizationId, created.id) },
        });

        const updatedLoad = await tx.load.update({
          where: { id: loadId },
          data: { status: 'RATE_CONFIRMATION' },
        });

        await this.audit.record(tx, {
          organizationId,
          action: 'Rate Confirmation Generated',
          entityType: 'Load',
          entityId: loadId,
          newValue: { documentId: withKey.id },
          actorUserId: actingUserId,
        });

        return {
          load: updatedLoad,
          document: withKey,
          carrierEmail: existing.assignedCarrier?.primaryContactEmail,
        };
      },
    );

    const jobData: RateConfirmationJobData = {
      documentId: document.id,
      organizationId,
      loadId,
    };
    await this.rateConfirmationQueue.add('generate', jobData, RATE_CONFIRMATION_JOB_OPTIONS);

    if (dto.sendEmail && carrierEmail) {
      await this.emailQueue.add(
        'send',
        {
          to: carrierEmail,
          subject: `Rate Confirmation — Load ${load.loadNumber}`,
          body: `A Rate Confirmation for Load ${load.loadNumber} has been generated and is attached.`,
          organizationId,
          entityType: 'Load',
          entityId: loadId,
        } satisfies EmailJobData,
        EMAIL_JOB_OPTIONS,
      );
      await this.prisma.withTenantTransaction(organizationId, (tx) =>
        this.audit.record(tx, {
          organizationId,
          action: 'Rate Confirmation Sent',
          entityType: 'Load',
          entityId: loadId,
          newValue: { documentId: document.id, sentTo: carrierEmail },
          actorUserId: actingUserId,
        }),
      );
    }

    return load;
  }

  /**
   * Driver Dispatch Email feature — read-only preview. Returns exactly
   * the subject/body the SEND action would use (same
   * buildDriverDispatchMessage call, same recipient-resolution logic) so
   * there is never a "preview says one thing, send does another" gap —
   * one formatter, one resolution path, used by both. Never enqueues
   * anything, never persists anything; safe to call as often as the UI
   * wants (e.g. every time the tab renders) purely to decide which UI
   * state to show (driver email already known vs. ask the dispatcher).
   */
  async previewDriverDispatchEmail(
    organizationId: string,
    loadId: string,
  ): Promise<DriverDispatchEmailPreview> {
    const ctx = await this.resolveDriverDispatchContext(organizationId, loadId);
    const uploadedRateConfDoc = await this.resolveUploadedRateConfirmationDocument(
      organizationId,
      loadId,
    );
    return {
      recipientEmail: ctx.recipientEmail,
      subject: ctx.message.subject,
      body: ctx.message.body,
      attachmentAvailable: Boolean(uploadedRateConfDoc),
      attachmentFileName: uploadedRateConfDoc?.fileName ?? null,
    };
  }

  /**
   * Driver Dispatch Email feature — a separate action from
   * generateRateConfirmation above; does not touch that method, its
   * route, or the carrier-email recipient logic in any way. The
   * recipient and message are BOTH re-resolved here server-side — a
   * `manualRecipientEmail` on the DTO is only ever used as a one-time
   * override when no on-file driver email was found, and is never
   * persisted to Driver/DispatchRecord or anywhere else. The carrier's
   * email is never considered as a fallback recipient under any
   * circumstance.
   */
  async sendDriverDispatchEmail(
    organizationId: string,
    loadId: string,
    dto: SendDriverDispatchEmailDto,
    actingUserId: string,
  ): Promise<{ recipientEmail: string }> {
    const ctx = await this.resolveDriverDispatchContext(organizationId, loadId);

    // Attachment is entirely optional and entirely gated by the caller's
    // explicit flag — never resolved/looked up at all when false, and
    // never falls back to the generated Rate Confirmation either way.
    let attachmentDocumentId: string | undefined;
    if (dto.attachRateConfirmation) {
      const uploadedRateConfDoc = await this.resolveUploadedRateConfirmationDocument(
        organizationId,
        loadId,
      );
      if (!uploadedRateConfDoc) {
        throw new BusinessRuleError(
          'The original uploaded Rate Confirmation PDF for this Load is not available — the dispatch email cannot be sent with the attachment requested.',
        );
      }
      attachmentDocumentId = uploadedRateConfDoc.id;
    }

    const recipientEmail = ctx.recipientEmail ?? dto.manualRecipientEmail;
    if (!recipientEmail) {
      throw new BusinessRuleError(
        'No email is on file for the assigned driver — provide a recipient email for this one-time send.',
      );
    }

    const jobData: EmailJobData = {
      to: recipientEmail,
      subject: ctx.message.subject,
      body: ctx.message.body,
      organizationId,
      entityType: 'Load',
      entityId: loadId,
      ...(attachmentDocumentId ? { attachmentDocumentId } : {}),
    };
    await this.emailQueue.add('send', jobData, EMAIL_JOB_OPTIONS);

    await this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.audit.record(tx, {
        organizationId,
        action: 'Driver Dispatch Email Sent',
        entityType: 'Load',
        entityId: loadId,
        newValue: {
          documentId: attachmentDocumentId ?? null,
          sentTo: recipientEmail,
          recipientSource: ctx.recipientEmail ? 'driver-on-file' : 'manual-override',
        },
        actorUserId: actingUserId,
      }),
    );

    return { recipientEmail };
  }

  /**
   * Shared by preview and send — resolves the Load/DispatchRecord/
   * assigned-driver-email/canonical-Rate-Confirmation-document context
   * once, in one tenant-scoped transaction. `sourceDriverId` is the only
   * path to a driver email (never a client-supplied driver id — the
   * frontend cannot choose an arbitrary driver), and that driver is
   * additionally required to belong to both this organization AND the
   * Load's own assigned carrier — a driver record from a different
   * carrier (even in the same org) is never treated as this Load's
   * driver.
   */
  private async resolveDriverDispatchContext(
    organizationId: string,
    loadId: string,
  ): Promise<{
    recipientEmail: string | null;
    message: DriverDispatchMessage;
  }> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({
        where: { id: loadId, organizationId },
        include: {
          assignedCarrier: true,
          customer: true,
          dispatchRecord: true,
          stops: { orderBy: { sequence: 'asc' } },
        },
      });
      if (!load) throw new NotFoundError('Load not found.');
      if (!load.dispatchRecord) {
        throw new BusinessRuleError(
          'This Load has not been dispatched yet — a dispatch record is required before sending a driver dispatch email.',
        );
      }
      if (!load.assignedCarrier) {
        throw new BusinessRuleError('This Load has no assigned carrier on record.');
      }

      let recipientEmail: string | null = null;
      if (load.dispatchRecord.sourceDriverId) {
        const driver = await tx.driver.findFirst({
          where: {
            id: load.dispatchRecord.sourceDriverId,
            organizationId,
            carrierId: load.assignedCarrierId ?? undefined,
          },
        });
        if (driver?.email) recipientEmail = driver.email;
      }

      const pickupStop = load.stops.find((s) => s.stopType === 'PICKUP') ?? load.stops[0];

      const message = buildDriverDispatchMessage({
        loadNumber: load.loadNumber,
        carrierLegalName: load.assignedCarrier.legalName,
        customerLegalName: load.customer.legalName,
        driverName: load.dispatchRecord.driverName,
        driverPhone: load.dispatchRecord.driverPhone,
        customerPoNumber: load.customerPoNumber,
        customerRate: load.customerRate !== null ? load.customerRate.toString() : null,
        stops: load.stops.map((s) => ({
          stopType: s.stopType,
          companyName: s.companyName,
          addressLine1: s.addressLine1,
          city: s.city,
          state: s.state,
          zip: s.zip,
          appointmentDatetime: s.appointmentDatetime ? s.appointmentDatetime.toISOString() : null,
          contactName: s.contactName,
          contactPhone: s.contactPhone,
        })),
        pickupStopNotes: pickupStop?.notes ?? null,
      });

      return { recipientEmail, message };
    });
  }

  /**
   * Driver Dispatch Email feature — the ORIGINAL, user-uploaded Rate
   * Confirmation PDF for this Load (never the system-generated carrier-
   * facing one, and never RATE_CONFIRMATION_INTAKE, which has no
   * reliable Load association at all). Both the generated and an
   * uploaded document share the exact same `RATE_CONFIRMATION` type code
   * and `entityType: 'LOAD', entityId: loadId` scoping — the ONLY
   * reliable discriminator is `generationStatus`, which the codebase
   * already guarantees is set only by the three system-generation call
   * sites and left `null` for every user-uploaded document (see
   * Document.generationStatus's own doc comment in schema.prisma).
   * `orderBy: uploadedAt desc` is a deliberate defensive tie-breaker for
   * a known, pre-existing, out-of-scope-here gap: the generic Load-level
   * document uploader (DocumentsTab.tsx) does not pass
   * `existingDocumentFamilyId`, so a re-upload does not deactivate a
   * prior current-version row — this can leave more than one row
   * `isCurrentVersion: true` for the same type. Taking the most recently
   * uploaded one is the least-surprising choice without touching that
   * unrelated versioning gap.
   */
  private async resolveUploadedRateConfirmationDocument(
    organizationId: string,
    loadId: string,
  ): Promise<{ id: string; fileName: string; fileStorageKey: string; mimeType: string } | null> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const documentType = await tx.documentTypeDefinition.findFirst({
        where: {
          code: RATE_CONFIRMATION_DOCUMENT_TYPE_CODE,
          OR: [{ organizationId }, { organizationId: null }],
        },
      });
      if (!documentType) return null;

      const doc = await tx.document.findFirst({
        where: {
          organizationId,
          entityType: 'LOAD',
          entityId: loadId,
          documentTypeId: documentType.id,
          isCurrentVersion: true,
          generationStatus: null,
        },
        orderBy: { uploadedAt: 'desc' },
      });
      if (!doc) return null;
      if (!isDocumentConsumable(doc.scanStatus) || doc.mimeType !== 'application/pdf') return null;

      return {
        id: doc.id,
        fileName: doc.fileName,
        fileStorageKey: doc.fileStorageKey,
        mimeType: doc.mimeType,
      };
    });
  }
}
