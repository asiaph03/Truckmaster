import { Inject, Injectable } from '@nestjs/common';
import { Document, DocumentEntityType, MembershipRoleName, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { UploadPodDocumentDto } from '../dto/upload-pod-document.dto';
import { UploadPopDocumentDto } from '../dto/upload-pop-document.dto';
import { ReviewDocumentDto } from '../dto/review-document.dto';
import {
  BusinessRuleError,
  NotFoundError,
  PermissionError,
  SelfReviewForbiddenError,
} from '../../../common/errors/app-error';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';
import { LoadPodStatusService } from '../../quote-load/services/load-pod-status.service';
import { MALWARE_SCAN_JOB_OPTIONS, MALWARE_SCAN_QUEUE } from './malware-scan.constants';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';
import {
  RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS,
  RATE_CONFIRMATION_EXTRACTION_QUEUE,
} from '../../rate-confirmation-extraction/rate-confirmation-extraction.constants';

/**
 * Document-upload permission is entity-type-aware (TECHNICAL_ARCHITECTURE.md
 * §2.5 — fine-grained, entity-aware checks belong in the service layer,
 * not the coarse Guard), since §7's matrix gives Carrier compliance-doc
 * upload a different role set (Admin/OpsMgr/Dispatcher) than the generic
 * Documents row. Only CARRIER is wired in Phase 2 — the other supported
 * entity types (Customer/Driver/Truck/Trailer) have no document types
 * pointing at them yet in the seeded system defaults, so there's no
 * locked permission rule to encode for them yet.
 */
const CARRIER_DOCUMENT_UPLOAD_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
];

/**
 * Workflow 7's own Actors table ("Uploading User: Admin, Operations
 * Manager, Dispatcher, or Accounting") — 🔒 LOCKED (Phase 5 sign-off):
 * Sales/Booking explicitly excluded, a different role set than
 * CARRIER_DOCUMENT_UPLOAD_ROLES (which lacks Accounting).
 */
const POD_UPLOAD_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'ACCOUNTING',
];

/**
 * The only two document type codes a Stop may ever receive, and which
 * Stop.stopType each requires — POD (Workflow 7 §7.1, delivery-only) and
 * POP, its symmetric pickup-only counterpart. Any other code against a
 * STOP entity is rejected outright.
 */
const REQUIRED_STOP_TYPE_BY_DOCUMENT_CODE: Record<string, 'PICKUP' | 'DELIVERY' | undefined> = {
  POD: 'DELIVERY',
  POP: 'PICKUP',
};

/**
 * Entities whose existence can actually be validated (Invoice/
 * CarrierPayment don't exist as tables yet — Phase 6 — or have no upload
 * path wired yet; DATABASE_DESIGN.md §7's entity_type enum anticipates
 * all of them, but this module only accepts uploads against
 * entities/paths that actually exist, rather than silently allowing an
 * orphaned polymorphic reference). STOP added in Phase 5 for
 * per-delivery-stop POD upload (Workflow 7). LOAD added for the
 * Load-Level Documents upload control (Load Detail's Documents tab) —
 * the generic Load-lifecycle document types (BOL, Lumper Receipt, Scale
 * Ticket, Accessorial Receipt, etc.) seeded with category LOAD.
 */
const SUPPORTED_ENTITY_TYPES: DocumentEntityType[] = [
  'CARRIER',
  'CUSTOMER',
  'DRIVER',
  'TRUCK',
  'TRAILER',
  'STOP',
  'LOAD',
  'RATE_CONFIRMATION_INTAKE',
];

/**
 * Rate Confirmation → New Load auto-populate feature — same role set as
 * `QUOTE_LOAD_CREATE_ROLES` (load.controller.ts), duplicated here rather
 * than imported since that constant is controller-local and this is a
 * different module; uploading a rate confirmation to extract is a
 * booking-adjacent action performed by the same actors who create Loads,
 * not a dispatch-tracking or carrier-compliance action.
 */
const RATE_CONFIRMATION_INTAKE_UPLOAD_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
];

@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly carrierEligibility: CarrierEligibilityService,
    private readonly loadPodStatus: LoadPodStatusService,
    @Inject(MALWARE_SCAN_QUEUE) private readonly scanQueue: Queue,
    @Inject(RATE_CONFIRMATION_EXTRACTION_QUEUE) private readonly extractionQueue: Queue,
  ) {}

  private async assertEntityExists(
    tx: Prisma.TransactionClient,
    organizationId: string,
    entityType: DocumentEntityType,
    entityId: string,
  ): Promise<void> {
    if (!SUPPORTED_ENTITY_TYPES.includes(entityType)) {
      throw new BusinessRuleError(
        `Document upload against entity type ${entityType} is not yet supported.`,
      );
    }
    const exists = await this.entityExists(tx, organizationId, entityType, entityId);
    if (!exists) {
      throw new NotFoundError(`${entityType} not found.`);
    }
  }

  private async entityExists(
    tx: Prisma.TransactionClient,
    organizationId: string,
    entityType: DocumentEntityType,
    entityId: string,
  ): Promise<boolean> {
    switch (entityType) {
      case 'CARRIER':
        return !!(await tx.carrier.findFirst({ where: { id: entityId, organizationId } }));
      case 'CUSTOMER':
        return !!(await tx.customer.findFirst({ where: { id: entityId, organizationId } }));
      case 'DRIVER':
        return !!(await tx.driver.findFirst({ where: { id: entityId, organizationId } }));
      case 'TRUCK':
        return !!(await tx.truck.findFirst({ where: { id: entityId, organizationId } }));
      case 'TRAILER':
        return !!(await tx.trailer.findFirst({ where: { id: entityId, organizationId } }));
      case 'STOP':
        return !!(await tx.stop.findFirst({ where: { id: entityId, organizationId } }));
      case 'LOAD':
        return !!(await tx.load.findFirst({ where: { id: entityId, organizationId } }));
      case 'RATE_CONFIRMATION_INTAKE':
        // No parent row exists to check by design — see the
        // DocumentEntityType enum's own doc comment. `entityId` is a
        // self-generated correlation id, not a foreign row's id;
        // organization-scoping via the surrounding withTenantTransaction/
        // RLS is the only guard this entity type needs or can have.
        return true;
      default:
        return false;
    }
  }

  private assertUploadPermission(entityType: DocumentEntityType): void {
    if (entityType === 'CARRIER') {
      const { roles = [] } = RequestContextStore.current();
      if (!CARRIER_DOCUMENT_UPLOAD_ROLES.some((r) => roles.includes(r))) {
        throw new PermissionError(
          'Uploading carrier documents requires Admin, Operations Manager, or Dispatcher.',
        );
      }
    }
    if (entityType === 'STOP') {
      const { roles = [] } = RequestContextStore.current();
      if (!POD_UPLOAD_ROLES.some((r) => roles.includes(r))) {
        throw new PermissionError(
          'Uploading a POD document requires Admin, Operations Manager, Dispatcher, or Accounting.',
        );
      }
    }
    if (entityType === 'LOAD') {
      const { roles = [] } = RequestContextStore.current();
      if (!POD_UPLOAD_ROLES.some((r) => roles.includes(r))) {
        throw new PermissionError(
          'Uploading a Load document requires Admin, Operations Manager, Dispatcher, or Accounting.',
        );
      }
    }
    if (entityType === 'RATE_CONFIRMATION_INTAKE') {
      const { roles = [] } = RequestContextStore.current();
      if (!RATE_CONFIRMATION_INTAKE_UPLOAD_ROLES.some((r) => roles.includes(r))) {
        throw new PermissionError(
          'Uploading a Rate Confirmation for extraction requires Admin, Operations Manager, Dispatcher, or Sales/Booking.',
        );
      }
    }
  }

  /** §8.1 steps 1-2 — creates the Document row and returns a presigned upload URL. */
  async initiateUpload(organizationId: string, dto: CreateDocumentDto, actingUserId: string) {
    this.assertUploadPermission(dto.entityType);

    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      await this.assertEntityExists(tx, organizationId, dto.entityType, dto.entityId);

      const documentType = await tx.documentTypeDefinition.findFirst({
        where: { id: dto.documentTypeId, OR: [{ organizationId }, { organizationId: null }] },
      });
      if (!documentType) throw new NotFoundError('Document type not found.');

      // Workflow 7 §7.1 — POD attaches only to a delivery Stop; POP is the
      // symmetric pickup-side equivalent, attaching only to a pickup Stop.
      // A Stop may only ever receive a POD/POP-type document (no other
      // document type has a defined Stop-level business process in any
      // locked workflow) — REQUIRED_STOP_TYPE_BY_DOCUMENT_CODE is the
      // single source of truth both PodDocumentsController and
      // PopDocumentsController
      // funnel through via their initiatePodUpload/initiatePopUpload
      // wrappers, so this check can never drift between the two routes.
      if (dto.entityType === 'STOP') {
        const requiredStopType = REQUIRED_STOP_TYPE_BY_DOCUMENT_CODE[documentType.code];
        if (!requiredStopType) {
          throw new BusinessRuleError('Only POD or POP documents can be uploaded against a Stop.');
        }
        const stop = await tx.stop.findFirst({ where: { id: dto.entityId, organizationId } });
        if (stop?.stopType !== requiredStopType) {
          throw new BusinessRuleError(
            requiredStopType === 'DELIVERY'
              ? 'POD documents can only be uploaded against a delivery Stop.'
              : 'POP documents can only be uploaded against a pickup Stop.',
          );
        }
      }

      let documentFamilyId: string | undefined;
      let versionNumber = 1;

      if (dto.existingDocumentFamilyId) {
        const currentVersion = await tx.document.findFirst({
          where: {
            organizationId,
            documentFamilyId: dto.existingDocumentFamilyId,
            isCurrentVersion: true,
          },
        });
        if (!currentVersion) throw new NotFoundError('Document family not found.');

        await tx.document.update({
          where: { id: currentVersion.id },
          data: { isCurrentVersion: false },
        });
        documentFamilyId = dto.existingDocumentFamilyId;
        versionNumber = currentVersion.versionNumber + 1;
      }

      const document = await tx.document.create({
        data: {
          organizationId,
          ...(documentFamilyId ? { documentFamilyId } : {}),
          entityType: dto.entityType,
          entityId: dto.entityId,
          documentTypeId: dto.documentTypeId,
          customTypeLabel: dto.customTypeLabel,
          fileStorageKey: '', // set below once the id is known
          fileName: dto.fileName,
          fileSizeBytes: dto.fileSizeBytes,
          mimeType: dto.mimeType,
          versionNumber,
          isCurrentVersion: true,
          scanStatus: 'PENDING',
          reviewStatus: documentType.requiresReview ? 'PENDING_REVIEW' : 'NOT_APPLICABLE',
          expirationDate: dto.expirationDate ? new Date(dto.expirationDate) : undefined,
          uploadedByUserId: actingUserId,
        },
      });

      const storageKey = this.storage.buildDocumentKey(organizationId, document.id);
      const updated = await tx.document.update({
        where: { id: document.id },
        data: { fileStorageKey: storageKey },
      });

      // Workflow 7 §7.1/§7.3 — POD uploads use their own locked audit-event
      // names instead of the generic 'Document Uploaded', distinguishing a
      // brand-new POD from a replacement version of an already-documented
      // stop. POP mirrors the identical naming convention (not itself
      // locked by any workflow doc, but kept symmetric with POD).
      const isStopUpload =
        dto.entityType === 'STOP' && (documentType.code === 'POD' || documentType.code === 'POP');
      const auditAction = isStopUpload
        ? documentFamilyId
          ? `${documentType.code} Document Version Added`
          : `${documentType.code} Uploaded`
        : 'Document Uploaded';

      await this.audit.record(tx, {
        organizationId,
        action: auditAction,
        entityType: dto.entityType,
        entityId: dto.entityId,
        newValue: {
          documentId: document.id,
          fileName: dto.fileName,
          documentTypeCode: documentType.code,
        },
        actorUserId: actingUserId,
      });

      const uploadUrl = await this.storage.getUploadUrl(storageKey, dto.mimeType);
      return { document: updated, uploadUrl };
    });
  }

  /**
   * Workflow 7 §7.1/§7.3 — the PodDocumentsController entry point.
   * Resolves the target delivery Stop (by loadId + sequence, mirroring
   * DispatchTrackingService's own lookup pattern) and the seeded POD
   * document type, then delegates entirely to `initiateUpload` — no
   * duplicated upload/versioning/permission logic, matching the
   * established "convenience wrapper, one implementation" pattern already
   * used for Carrier documents.
   */
  async initiatePodUpload(
    organizationId: string,
    loadId: string,
    sequence: number,
    dto: UploadPodDocumentDto,
    actingUserId: string,
  ) {
    const { stop, podType } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const stop = await tx.stop.findFirst({ where: { loadId, organizationId, sequence } });
        if (!stop) throw new NotFoundError('Stop not found.');
        const podType = await tx.documentTypeDefinition.findFirst({
          where: { code: 'POD', OR: [{ organizationId }, { organizationId: null }] },
        });
        if (!podType) throw new NotFoundError('POD document type is not configured.');
        return { stop, podType };
      },
    );

    return this.initiateUpload(
      organizationId,
      { ...dto, entityType: 'STOP', entityId: stop.id, documentTypeId: podType.id },
      actingUserId,
    );
  }

  /**
   * The PopDocumentsController entry point — symmetric pickup-side
   * counterpart of `initiatePodUpload` immediately above, resolving the
   * target pickup Stop and the seeded POP document type, then delegating
   * entirely to the same `initiateUpload` (no duplicated upload/
   * versioning/permission logic — identical "convenience wrapper, one
   * implementation" pattern).
   */
  async initiatePopUpload(
    organizationId: string,
    loadId: string,
    sequence: number,
    dto: UploadPopDocumentDto,
    actingUserId: string,
  ) {
    const { stop, popType } = await this.prisma.withTenantTransaction(
      organizationId,
      async (tx) => {
        const stop = await tx.stop.findFirst({ where: { loadId, organizationId, sequence } });
        if (!stop) throw new NotFoundError('Stop not found.');
        const popType = await tx.documentTypeDefinition.findFirst({
          where: { code: 'POP', OR: [{ organizationId }, { organizationId: null }] },
        });
        if (!popType) throw new NotFoundError('POP document type is not configured.');
        return { stop, popType };
      },
    );

    return this.initiateUpload(
      organizationId,
      { ...dto, entityType: 'STOP', entityId: stop.id, documentTypeId: popType.id },
      actingUserId,
    );
  }

  /** §8.1 step 3 — client confirms the direct-to-S3 upload completed; enqueues the scan job. */
  async confirmUpload(
    organizationId: string,
    documentId: string,
    actingUserId: string,
  ): Promise<Document> {
    const document = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findFirst({
        where: { id: documentId, organizationId },
      }),
    );
    if (!document) throw new NotFoundError('Document not found.');
    if (document.scanStatus !== 'PENDING') {
      throw new BusinessRuleError('This document has already been confirmed.');
    }

    await this.scanQueue.add(
      'scan',
      {
        documentId: document.id,
        organizationId,
        storageKey: document.fileStorageKey,
      },
      MALWARE_SCAN_JOB_OPTIONS,
    );

    await this.prisma.withTenantTransaction(organizationId, (tx) =>
      this.audit.record(tx, {
        organizationId,
        action: 'Document Upload Confirmed — Scan Queued',
        entityType: document.entityType,
        entityId: document.entityId,
        actorUserId: actingUserId,
      }),
    );

    return document;
  }

  list(
    organizationId: string,
    entityType: DocumentEntityType,
    entityId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      await this.assertViewPermission(
        tx,
        organizationId,
        entityType,
        entityId,
        actingUserId,
        actingRoles,
      );
      return tx.document.findMany({
        where: { organizationId, entityType, entityId, isCurrentVersion: true },
        orderBy: { uploadedAt: 'desc' },
      });
    });
  }

  /**
   * §8.4's own doc-comment on `getDownloadUrl` below always intended
   * "permission to view the parent entity" to be enforced somewhere —
   * that never actually happened for the two entity types that have a
   * real record-level view restriction anywhere else in the app
   * (Invoice, Carrier Payment). Every other entity type has no such
   * restriction today (no `@Roles()`, no ownership concept on its own
   * view routes), so this is intentionally a no-op for them — reusing
   * the absence of a rule is still reusing the rule, same principle
   * `DocumentSearchService.buildWhere` already applies.
   *
   * Reuses `FINANCIAL_VIEW_ROLES` and replicates `InvoiceService`'s own
   * `isOwnDeal` rule inline (same reasoning `ReportingService.searchInvoices`
   * and `DocumentSearchService.resolveInvoiceVisibility` already used: a
   * small local check rather than a cross-service import of a private
   * method, or touching `InvoiceService`).
   */
  private async assertViewPermission(
    tx: Prisma.TransactionClient,
    organizationId: string,
    entityType: DocumentEntityType,
    entityId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ): Promise<void> {
    if (entityType === 'CARRIER_PAYMENT') {
      if (!actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) {
        throw new PermissionError('You do not have permission to view Carrier Payment documents.');
      }
      return;
    }

    if (entityType === 'INVOICE') {
      if (actingRoles.some((r) => FINANCIAL_VIEW_ROLES.includes(r))) return;

      if (actingRoles.includes('SALES_BOOKING')) {
        const invoice = await tx.invoice.findFirst({
          where: { id: entityId, organizationId },
          include: { customer: true },
        });
        if (invoice && this.isOwnDeal(invoice.customer, actingUserId)) return;
      }

      throw new PermissionError('You do not have permission to view Invoice documents.');
    }
  }

  /** Mirrors `InvoiceService.isOwnDeal` exactly — "Account Owner, fallback creator." */
  private isOwnDeal(
    customer: { accountOwnerUserId: string | null; createdByUserId: string },
    actingUserId: string,
  ): boolean {
    return customer.accountOwnerUserId
      ? customer.accountOwnerUserId === actingUserId
      : customer.createdByUserId === actingUserId;
  }

  /**
   * Frontend Phase 5 approved gap-fix — Carrier Compliance Review Queue
   * (cross-carrier). Same `reviewStatus === 'PENDING_REVIEW'` predicate
   * `review()` already checks per-document; this just drops the
   * entityId scoping `list()` requires and adds entityType: 'CARRIER' —
   * the only entity type any seeded document type currently requires
   * review for (see `assertUploadPermission`'s own comment above). No
   * new tables/columns/RLS. `entityId` has no native FK (polymorphic,
   * DATABASE_DESIGN.md §7), so the Carrier legal name is resolved with
   * one bounded follow-up query rather than a Prisma include.
   */
  async listPendingReview(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const documents = await tx.document.findMany({
        where: {
          organizationId,
          entityType: 'CARRIER',
          reviewStatus: 'PENDING_REVIEW',
          isCurrentVersion: true,
        },
        include: { documentType: true },
        orderBy: { uploadedAt: 'asc' },
      });
      if (documents.length === 0) return [];

      const carrierIds = [...new Set(documents.map((d) => d.entityId))];
      const carriers = await tx.carrier.findMany({
        where: { id: { in: carrierIds }, organizationId },
        select: { id: true, legalName: true },
      });
      const carrierNameById = new Map(carriers.map((c) => [c.id, c.legalName]));

      return documents.map((d) => ({
        ...d,
        carrierLegalName: carrierNameById.get(d.entityId) ?? null,
      }));
    });
  }

  /** §8.4 — permission to view the parent entity (enforced by `assertViewPermission` below) + scan_status === CLEAN. */
  async getDownloadUrl(
    organizationId: string,
    documentId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ): Promise<{ url: string }> {
    const document = await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const doc = await tx.document.findFirst({
        where: { id: documentId, organizationId },
      });
      if (!doc) throw new NotFoundError('Document not found.');
      await this.assertViewPermission(
        tx,
        organizationId,
        doc.entityType,
        doc.entityId,
        actingUserId,
        actingRoles,
      );
      return doc;
    });
    if (document.scanStatus !== 'CLEAN') {
      throw new BusinessRuleError(
        `This document is not available for download (scan status: ${document.scanStatus}).`,
      );
    }
    const url = await this.storage.getDownloadUrl(document.fileStorageKey);
    return { url };
  }

  /**
   * Workflow 3 §3.4 / TECHNICAL_ARCHITECTURE.md §5.2, §8.5 — Approve/Reject.
   * Self-review prevention and the requires_review gate are both enforced
   * here regardless of what the calling UI shows/hides.
   */
  async review(
    organizationId: string,
    documentId: string,
    dto: ReviewDocumentDto,
    actingUserId: string,
  ): Promise<Document> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const document = await tx.document.findFirst({ where: { id: documentId, organizationId } });
      if (!document) throw new NotFoundError('Document not found.');

      const documentType = await tx.documentTypeDefinition.findFirst({
        where: { id: document.documentTypeId },
      });
      if (!documentType?.requiresReview) {
        throw new BusinessRuleError('This document type does not require review.');
      }
      if (document.reviewStatus !== 'PENDING_REVIEW') {
        throw new BusinessRuleError('This document is not pending review.');
      }
      if (document.uploadedByUserId === actingUserId) {
        throw new SelfReviewForbiddenError(
          'You cannot approve a document you uploaded. Another Compliance reviewer must approve it.',
        );
      }

      const updated = await tx.document.update({
        where: { id: documentId },
        data: {
          reviewStatus: dto.decision,
          reviewedByUserId: actingUserId,
          reviewedAt: new Date(),
          rejectionReason: dto.decision === 'REJECTED' ? dto.rejectionReason : null,
        },
      });

      await this.audit.record(tx, {
        organizationId,
        action:
          dto.decision === 'APPROVED'
            ? 'Compliance Document Approved'
            : 'Compliance Document Rejected',
        entityType: document.entityType,
        entityId: document.entityId,
        newValue: { documentId, decision: dto.decision, rejectionReason: dto.rejectionReason },
        actorUserId: actingUserId,
      });

      if (document.entityType === 'CARRIER') {
        await this.carrierEligibility.recalculate(tx, organizationId, document.entityId);
      }

      return updated;
    });
  }

  /** Invoked only by the malware-scan worker (system-triggered, no acting user). */
  async applyScanResult(
    organizationId: string,
    documentId: string,
    result: { status: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'; provider: string },
  ): Promise<void> {
    await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const document = await tx.document.findFirst({ where: { id: documentId, organizationId } });
      if (!document) return;

      let fileStorageKey = document.fileStorageKey;
      if (result.status === 'INFECTED' || result.status === 'SCAN_FAILED') {
        const quarantineKey = this.storage.buildQuarantineKey(organizationId, document.id);
        await this.storage.moveToQuarantine(document.fileStorageKey, quarantineKey);
        fileStorageKey = quarantineKey;
      }

      await tx.document.update({
        where: { id: documentId },
        data: {
          scanStatus: result.status,
          scannedAt: new Date(),
          scanProvider: result.provider,
          fileStorageKey,
        },
      });

      const actionByStatus: Record<typeof result.status, string> = {
        CLEAN: 'Document Scan Completed — Clean',
        INFECTED: 'Document Scan Completed — Infected (Quarantined)',
        SCAN_FAILED: 'Document Scan Failed (Quarantined)',
      };

      await this.audit.record(tx, {
        organizationId,
        action: actionByStatus[result.status],
        entityType: document.entityType,
        entityId: document.entityId,
        newValue: { documentId, scanStatus: result.status, provider: result.provider },
        actorType: 'SYSTEM',
      });

      // Workflow 7 §7.2 / TECHNICAL_ARCHITECTURE §6.4 — 🔒 LOCKED (Phase 5
      // sign-off): only a CLEAN scan result can ever make a POD count
      // toward pod_status, so recalculation is driven from here (after the
      // scan outcome is known) rather than from initiateUpload. Run
      // unconditionally on every outcome (CLEAN/INFECTED/SCAN_FAILED) —
      // LoadPodStatusService's own query already filters to scanStatus=
      // CLEAN, so a non-CLEAN result correctly never counts without any
      // extra branching here.
      if (document.entityType === 'STOP') {
        const stop = await tx.stop.findFirst({
          where: { id: document.entityId, organizationId },
        });
        if (stop) {
          await this.loadPodStatus.recalculatePodStatus(tx, organizationId, stop.loadId);
        }
      }

      // Rate Confirmation → New Load auto-populate feature — mirrors the
      // STOP branch above exactly: extraction only ever starts from here,
      // after the scan outcome is known, and only on CLEAN. INFECTED/
      // SCAN_FAILED documents are already quarantined above and never
      // reach extraction — malware scanning can never be bypassed.
      if (document.entityType === 'RATE_CONFIRMATION_INTAKE' && result.status === 'CLEAN') {
        await this.extractionQueue.add(
          'extract',
          {
            extractionId: document.entityId,
            documentId: document.id,
            organizationId,
            storageKey: fileStorageKey,
          },
          RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS,
        );
      }
    });
  }
}
