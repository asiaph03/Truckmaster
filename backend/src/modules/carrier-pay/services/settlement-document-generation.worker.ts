import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../../../common/redis/redis.module';
import { WorkerHeartbeatService } from '../../../common/worker-health/worker-heartbeat.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { IPdfGenerator, PDF_GENERATOR } from '../../../common/pdf/pdf-generator.interface';
import { SETTLEMENT_QUEUE_NAME, SettlementJobData } from './settlement.constants';

/**
 * Workflow 9 §9.8 — async PDF generation for a just-Paid Carrier Payment,
 * off the request path. Structurally identical to
 * RateConfirmationGenerationWorker/InvoiceDocumentGenerationWorker: its own
 * duplicated Redis connection, `.quit()`'d in onModuleDestroy.
 */
@Injectable()
export class SettlementDocumentGenerationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementDocumentGenerationWorker.name);
  private worker?: Worker<SettlementJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PDF_GENERATOR) private readonly pdfGenerator: IPdfGenerator,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'settlement-pdf-worker');
    this.worker = new Worker<SettlementJobData>(
      SETTLEMENT_QUEUE_NAME,
      async (job) => {
        try {
          await this.processJob(job.data);
        } catch (error) {
          // Frontend Phase 16 — same retry-then-terminal-status pattern as
          // MalwareScanWorker/RateConfirmationGenerationWorker.
          const maxAttempts = job.opts.attempts ?? 1;
          if (job.attemptsMade + 1 >= maxAttempts) {
            // Monitoring Phase 4A-4 — job.processedOn is BullMQ's own
            // timestamp for when the job became active.
            const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
            this.logger.error(
              `Settlement PDF generation for document ${job.data.documentId} (org ${job.data.organizationId}) failed after ${maxAttempts} attempts${durationMs !== undefined ? ` (${durationMs}ms)` : ''} — recording FAILED.`,
              error instanceof Error ? error.stack : String(error),
            );
            await this.markFailed(job.data);
            return;
          }
          throw error;
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Settlement PDF job ${job?.id} (org ${job?.data.organizationId}) failed: ${error.message}`,
        error.stack,
      );
      this.heartbeat.recordActivity('settlement-pdf-worker', 'failed');
    });
    this.worker.on('active', () => this.heartbeat.recordActivity('settlement-pdf-worker', 'active'));
    this.worker.on('completed', (job) => {
      const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
      this.logger.log(
        `Settlement PDF job ${job.id} (org ${job.data.organizationId}) completed${durationMs !== undefined ? ` in ${durationMs}ms` : ''}.`,
      );
      this.heartbeat.recordActivity('settlement-pdf-worker', 'completed');
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Settlement PDF worker connection error: ${error.message}`, error.stack);
      this.heartbeat.recordError('settlement-pdf-worker', 'error');
    });
    // Monitoring Phase 4A-5 — purely observational; deliberately does NOT
    // touch WorkerHeartbeatService (see malware-scan.worker.ts for the
    // full rationale). No organizationId available from this event.
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Settlement PDF job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('settlement-pdf-worker', () => this.worker!.isRunning());
  }

  private async markFailed(data: SettlementJobData): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.document.updateMany({
        where: { id: data.documentId, organizationId: data.organizationId },
        data: { generationStatus: 'FAILED' },
      }),
    );
  }

  private async processJob(data: SettlementJobData): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: data.documentId, organizationId: data.organizationId },
      });
      if (!document) return;

      const carrierPayment = await tx.carrierPayment.findFirst({
        where: { id: data.carrierPaymentId, organizationId: data.organizationId },
        include: { carrier: true, load: true },
      });
      if (!carrierPayment || !carrierPayment.paidAt) return;

      const pdfBytes = await this.pdfGenerator.generateSettlement({
        carrierLegalName: carrierPayment.carrier.legalName,
        loadNumber: carrierPayment.load.loadNumber,
        paymentAmount: carrierPayment.amount.toString(),
        paymentType: carrierPayment.paymentType,
        paymentDate: carrierPayment.paidAt.toISOString(),
        method: carrierPayment.method ?? undefined,
        referenceNumber: carrierPayment.referenceNumber ?? undefined,
      });

      await this.storage.putObject(document.fileStorageKey, pdfBytes, 'application/pdf');

      await tx.document.update({
        where: { id: document.id },
        data: { fileSizeBytes: BigInt(pdfBytes.length), generationStatus: 'COMPLETE' },
      });

      await this.audit.record(tx, {
        organizationId: data.organizationId,
        action: 'Settlement PDF Generated',
        entityType: 'CarrierPayment',
        entityId: data.carrierPaymentId,
        newValue: { documentId: document.id, fileSizeBytes: pdfBytes.length },
        actorType: 'SYSTEM',
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.heartbeat.unregister('settlement-pdf-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
