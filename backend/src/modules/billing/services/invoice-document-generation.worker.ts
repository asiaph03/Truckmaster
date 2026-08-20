import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { StorageService } from '../../../common/storage/storage.service';
import { IPdfGenerator, PDF_GENERATOR } from '../../../common/pdf/pdf-generator.interface';
import { INVOICE_QUEUE_NAME, InvoiceJobData } from './invoice.constants';

/**
 * Workflow 8 §8.6 — async PDF generation for a Sent invoice, off the
 * request path. Structurally identical to RateConfirmationGenerationWorker
 * (Phase 4): its own duplicated Redis connection, `.quit()`'d in
 * onModuleDestroy to avoid the open-handle-keeps-Jest-alive bug fixed at
 * the close of Phase 3.
 */
@Injectable()
export class InvoiceDocumentGenerationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceDocumentGenerationWorker.name);
  private worker?: Worker<InvoiceJobData>;
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
    this.worker = new Worker<InvoiceJobData>(
      INVOICE_QUEUE_NAME,
      async (job) => this.processJob(job.data),
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Invoice PDF job ${job?.id} failed: ${error.message}`, error.stack);
    });
  }

  private async processJob(data: InvoiceJobData): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: data.documentId, organizationId: data.organizationId },
      });
      if (!document) return;

      const invoice = await tx.invoice.findFirst({
        where: { id: data.invoiceId, organizationId: data.organizationId },
        include: { lineItems: true, customer: true },
      });
      if (!invoice) return;

      const pdfBytes = await this.pdfGenerator.generateInvoice({
        invoiceNumber: invoice.invoiceNumber,
        customerLegalName: invoice.customer.legalName,
        status: invoice.status,
        total: invoice.total.toString(),
        remainingBalance: invoice.remainingBalance.toString(),
        dueDate: invoice.dueDate?.toISOString(),
        lineItems: invoice.lineItems.map((li) => ({
          description: li.description,
          amount: li.amount.toString(),
        })),
      });

      await this.storage.putObject(document.fileStorageKey, pdfBytes, 'application/pdf');

      await tx.document.update({
        where: { id: document.id },
        data: { fileSizeBytes: BigInt(pdfBytes.length) },
      });

      await this.audit.record(tx, {
        organizationId: data.organizationId,
        action: 'Invoice PDF Generated',
        entityType: 'Invoice',
        entityId: data.invoiceId,
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
