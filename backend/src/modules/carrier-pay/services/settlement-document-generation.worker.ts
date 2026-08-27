import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
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
  ) {}

  onModuleInit(): void {
    this.workerConnection = this.redis.duplicate();
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
            this.logger.error(
              `Settlement PDF generation for document ${job.data.documentId} failed after ${maxAttempts} attempts — recording FAILED.`,
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
      this.logger.error(`Settlement PDF job ${job?.id} failed: ${error.message}`, error.stack);
    });
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
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
