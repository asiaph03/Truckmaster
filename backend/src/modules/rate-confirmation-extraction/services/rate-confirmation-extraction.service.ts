import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NotFoundError, BusinessRuleError } from '../../../common/errors/app-error';
import { DocumentService } from '../../document/services/document.service';
import { InitiateRateConfirmationExtractionDto } from '../dto/initiate-rate-confirmation-extraction.dto';
import {
  RateConfirmationExtractionJobStore,
  ExtractionStatus,
} from './rate-confirmation-extraction-job-store.service';
import {
  RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS,
  RATE_CONFIRMATION_EXTRACTION_QUEUE,
} from '../rate-confirmation-extraction.constants';
import { ExtractedRateConfirmationData } from '../rate-confirmation-extractor.interface';

const RATE_CONFIRMATION_INTAKE_DOCUMENT_TYPE_CODE = 'RATE_CONFIRMATION_INTAKE';

export interface RateConfirmationExtractionStatusResponse {
  extractionId: string;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED';
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  data: ExtractedRateConfirmationData | null;
}

/**
 * Rate Confirmation → New Load auto-populate feature — orchestrates the
 * dedicated `/rate-confirmation-extractions` endpoints on top of the
 * EXISTING document upload/malware-scan infrastructure (DocumentService),
 * never duplicating it. `initiate`/`confirm` are thin wrappers around
 * `DocumentService.initiateUpload`/`confirmUpload` — the exact same
 * presigned-S3-upload → BullMQ-scan-job pipeline every other document
 * type already uses. Only the extraction-specific concerns (the Redis
 * job record, the retry endpoint) are new.
 */
@Injectable()
export class RateConfirmationExtractionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentService: DocumentService,
    private readonly jobStore: RateConfirmationExtractionJobStore,
    @Inject(RATE_CONFIRMATION_EXTRACTION_QUEUE) private readonly extractionQueue: Queue,
  ) {}

  async initiate(
    organizationId: string,
    dto: InitiateRateConfirmationExtractionDto,
    actingUserId: string,
  ): Promise<{ extractionId: string; uploadUrl: string }> {
    const documentTypeId = await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const documentType = await tx.documentTypeDefinition.findFirst({
        where: { organizationId: null, code: RATE_CONFIRMATION_INTAKE_DOCUMENT_TYPE_CODE },
      });
      if (!documentType) {
        // Only reachable if the seed script hasn't been run yet.
        throw new NotFoundError('Rate Confirmation intake document type is not configured.');
      }
      return documentType.id;
    });

    const extractionId = randomUUID();

    const { document, uploadUrl } = await this.documentService.initiateUpload(
      organizationId,
      {
        entityType: 'RATE_CONFIRMATION_INTAKE',
        entityId: extractionId,
        documentTypeId,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        fileSizeBytes: dto.fileSizeBytes,
      },
      actingUserId,
    );

    await this.jobStore.create(organizationId, extractionId, document.id);

    return { extractionId, uploadUrl };
  }

  async confirm(
    organizationId: string,
    extractionId: string,
    actingUserId: string,
  ): Promise<{ extractionId: string; scanStatus: 'PENDING' }> {
    const job = await this.jobStore.get(organizationId, extractionId);
    if (!job) throw new NotFoundError('Extraction not found.');

    await this.documentService.confirmUpload(organizationId, job.documentId, actingUserId);

    return { extractionId, scanStatus: 'PENDING' };
  }

  async getStatus(
    organizationId: string,
    extractionId: string,
  ): Promise<RateConfirmationExtractionStatusResponse> {
    const job = await this.jobStore.get(organizationId, extractionId);
    if (!job) throw new NotFoundError('Extraction not found.');

    const document = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findFirst({ where: { id: job.documentId, organizationId } }),
    );
    if (!document) throw new NotFoundError('Extraction not found.');

    return {
      extractionId,
      scanStatus: document.scanStatus,
      extractionStatus: job.extractionStatus,
      extractionError: job.extractionError,
      data: job.data,
    };
  }

  async retry(
    organizationId: string,
    extractionId: string,
  ): Promise<{ extractionId: string; extractionStatus: 'PENDING' }> {
    const job = await this.jobStore.get(organizationId, extractionId);
    if (!job) throw new NotFoundError('Extraction not found.');

    const document = await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findFirst({ where: { id: job.documentId, organizationId } }),
    );
    if (!document) throw new NotFoundError('Extraction not found.');
    if (document.scanStatus !== 'CLEAN') {
      throw new BusinessRuleError(
        'Extraction can only be retried once the document has passed malware scanning.',
      );
    }

    await this.jobStore.resetForRetry(organizationId, extractionId);

    await this.extractionQueue.add(
      'extract',
      {
        extractionId,
        documentId: document.id,
        organizationId,
        storageKey: document.fileStorageKey,
      },
      RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS,
    );

    return { extractionId, extractionStatus: 'PENDING' };
  }
}
