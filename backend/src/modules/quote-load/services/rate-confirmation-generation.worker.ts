import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { IPdfGenerator, PDF_GENERATOR } from '../../../common/pdf/pdf-generator.interface';
import {
  RATE_CONFIRMATION_QUEUE_NAME,
  RateConfirmationJobData,
} from './rate-confirmation.constants';

/**
 * Workflow 5 §5.7 step 2 — the async worker side of Rate Confirmation PDF
 * generation. Runs in-process (same modular monolith, no separate worker
 * deployment in V1), off the request path, mirroring MalwareScanWorker's
 * structure exactly: its own duplicated Redis connection (never the shared
 * REDIS_CLIENT directly — BullMQ's Worker needs a dedicated blocking
 * connection), explicitly `.quit()`'d in onModuleDestroy so it never
 * becomes the kind of open handle that keeps a Jest e2e run's process
 * alive after the test run itself has finished (the exact bug fixed for
 * the malware-scan queue at the close of Phase 3).
 */
@Injectable()
export class RateConfirmationGenerationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateConfirmationGenerationWorker.name);
  private worker?: Worker<RateConfirmationJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PDF_GENERATOR) private readonly pdfGenerator: IPdfGenerator,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = this.redis.duplicate();
    this.worker = new Worker<RateConfirmationJobData>(
      RATE_CONFIRMATION_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Rate Confirmation PDF job ${job?.id} failed: ${error.message}`,
        error.stack,
      );
    });
  }

  private async processJob(data: RateConfirmationJobData): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: data.documentId, organizationId: data.organizationId },
      });
      if (!document) return; // deleted/inaccessible — nothing to generate for

      const load = await tx.load.findFirst({
        where: { id: data.loadId, organizationId: data.organizationId },
        include: { stops: true, customer: true, assignedCarrier: true },
      });
      if (!load || !load.assignedCarrier || load.carrierRate === null) return;

      const pdfBytes = await this.pdfGenerator.generateRateConfirmation({
        loadNumber: load.loadNumber,
        carrierLegalName: load.assignedCarrier.legalName,
        carrierRate: load.carrierRate.toString(),
        customerLegalName: load.customer.legalName,
        equipmentType: load.equipmentType,
        stops: load.stops.map((s) => ({
          sequence: s.sequence,
          stopType: s.stopType,
          city: s.city,
          state: s.state,
        })),
      });

      await this.storage.putObject(document.fileStorageKey, pdfBytes, 'application/pdf');

      await tx.document.update({
        where: { id: document.id },
        data: { fileSizeBytes: BigInt(pdfBytes.length) },
      });

      await this.audit.record(tx, {
        organizationId: data.organizationId,
        action: 'Rate Confirmation PDF Generated',
        entityType: 'Load',
        entityId: data.loadId,
        newValue: { documentId: document.id, fileSizeBytes: pdfBytes.length },
        actorType: 'SYSTEM',
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
