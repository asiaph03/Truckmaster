import { Inject, Injectable } from '@nestjs/common';
import { Document, DocumentEntityType, MembershipRoleName, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { ReviewDocumentDto } from '../dto/review-document.dto';
import {
  BusinessRuleError,
  NotFoundError,
  PermissionError,
  SelfReviewForbiddenError,
} from '../../../common/errors/app-error';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';
import { MALWARE_SCAN_QUEUE } from './malware-scan.constants';

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
 * Entities whose existence can actually be validated in Phase 2 (Load,
 * Stop, Invoice, CarrierPayment don't exist as tables until later phases
 * — DATABASE_DESIGN.md §7's entity_type enum anticipates them, but this
 * module only accepts uploads against entities that actually exist yet,
 * rather than silently allowing an orphaned polymorphic reference).
 */
const SUPPORTED_ENTITY_TYPES: DocumentEntityType[] = [
  'CARRIER',
  'CUSTOMER',
  'DRIVER',
  'TRUCK',
  'TRAILER',
];

@Injectable()
export class DocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly carrierEligibility: CarrierEligibilityService,
    @Inject(MALWARE_SCAN_QUEUE) private readonly scanQueue: Queue,
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
          uploadedByUserId: actingUserId,
        },
      });

      const storageKey = this.storage.buildDocumentKey(organizationId, document.id);
      const updated = await tx.document.update({
        where: { id: document.id },
        data: { fileStorageKey: storageKey },
      });

      await this.audit.record(tx, {
        organizationId,
        action: 'Document Uploaded',
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

    await this.scanQueue.add('scan', {
      documentId: document.id,
      organizationId,
      storageKey: document.fileStorageKey,
    });

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

  list(organizationId: string, entityType: DocumentEntityType, entityId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findMany({
        where: { organizationId, entityType, entityId, isCurrentVersion: true },
        orderBy: { uploadedAt: 'desc' },
      }),
    );
  }

  /** §8.4 — permission to view the parent entity (checked by caller/guard) + scan_status === CLEAN. */
  async getDownloadUrl(organizationId: string, documentId: string): Promise<{ url: string }> {
    const document = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findFirst({
        where: { id: documentId, organizationId },
      }),
    );
    if (!document) throw new NotFoundError('Document not found.');
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
    });
  }
}
