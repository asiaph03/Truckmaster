import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { AppError } from '../../../common/errors/app-error';
import { ImportAdapterRegistry } from '../adapters/import-adapter.registry';
import { ParentResolutionService } from '../adapters/parent-resolution';
import { ImportDuplicateCache } from '../adapters/types';
import { IMPORT_COMMIT_QUEUE_NAME, ImportCommitJobData } from '../import.constants';

/**
 * Bulk Import commit worker (approved technical design, Decision 6 —
 * one BullMQ job per ImportBatch; approved queue decision — mirrors
 * RateConfirmationGenerationWorker's exact structure: duplicated ioredis
 * connection, .quit() in onModuleDestroy, only-final-attempt-records-
 * terminal-status retry pattern for genuinely job-level/transient
 * failures.
 *
 * Per-row processing (approved Decision 5/11/12): each row gets its own
 * try/catch so one bad row is recorded FAILED and processing continues —
 * an error here never propagates to abort the whole job or roll back
 * already-imported rows. Idempotent/resumable by construction: only rows
 * still `VALID` (not yet terminal) are fetched for processing, so a job
 * retry after a transient failure picks up where it left off rather than
 * reprocessing already-committed rows.
 */
@Injectable()
export class ImportCommitWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportCommitWorker.name);
  private worker?: Worker<ImportCommitJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly adapters: ImportAdapterRegistry,
    private readonly parentResolution: ParentResolutionService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = this.redis.duplicate();
    this.worker = new Worker<ImportCommitJobData>(
      IMPORT_COMMIT_QUEUE_NAME,
      async (job) => {
        try {
          await this.processJob(job.data);
        } catch (error) {
          const maxAttempts = job.opts.attempts ?? 1;
          if (job.attemptsMade + 1 >= maxAttempts) {
            this.logger.error(
              `Import batch ${job.data.importBatchId} commit failed after ${maxAttempts} attempts — recording FAILED.`,
              error instanceof Error ? error.stack : String(error),
            );
            await this.markBatchFailed(job.data);
            return;
          }
          throw error;
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Import commit job ${job?.id} failed: ${error.message}`, error.stack);
    });
  }

  private async markBatchFailed(data: ImportCommitJobData): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.importBatch.updateMany({
        where: { id: data.importBatchId, organizationId: data.organizationId },
        data: { status: 'FAILED', completedAt: new Date() },
      }),
    );
  }

  private async processJob(data: ImportCommitJobData): Promise<void> {
    const batch = await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.importBatch.findFirst({
        where: { id: data.importBatchId, organizationId: data.organizationId },
      }),
    );
    if (!batch) return;

    const adapter = this.adapters.get(batch.entityType);
    const eligibleRows = await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.importBatchRow.findMany({
        where: { importBatchId: batch.id, organizationId: data.organizationId, status: 'VALID' },
        orderBy: { rowNumber: 'asc' },
      }),
    );

    const cache: ImportDuplicateCache = {};

    for (const row of eligibleRows) {
      const mappedData = { ...(row.mappedData as Record<string, unknown>) };
      const parentLegalName = mappedData.__parentLegalName as string | undefined;
      delete mappedData.__parentLegalName;

      if (row.duplicateWarning && !row.acknowledgeDuplicate) {
        await this.markRow(data.organizationId, row.id, {
          status: 'SKIPPED',
          errors: ['Duplicate not acknowledged — skipped.'],
        });
        continue;
      }

      let parentId: string | undefined;
      if (adapter.parentField) {
        const result = await this.parentResolution.resolveByLegalName(
          data.organizationId,
          adapter.parentEntity!,
          parentLegalName,
        );
        if ('error' in result) {
          await this.markRow(data.organizationId, row.id, {
            status: 'FAILED',
            errors: [result.error],
          });
          continue;
        }
        parentId = result.id;
      }

      try {
        const { entityId } = await adapter.commit(
          data.organizationId,
          mappedData,
          batch.createdByUserId,
          parentId,
          row.acknowledgeDuplicate,
          cache,
        );
        await this.markRow(data.organizationId, row.id, {
          status: 'IMPORTED',
          createdEntityId: entityId,
        });
      } catch (error) {
        const message =
          error instanceof AppError ? error.message : 'Unexpected error during import.';
        if (!(error instanceof AppError)) {
          this.logger.error(
            `Unexpected error importing row ${row.rowNumber} of batch ${batch.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
        }
        await this.markRow(data.organizationId, row.id, { status: 'FAILED', errors: [message] });
      }
    }

    await this.finalizeBatch(data.organizationId, batch.id, batch.createdByUserId);
  }

  private async markRow(
    organizationId: string,
    rowId: string,
    data: {
      status: 'IMPORTED' | 'FAILED' | 'SKIPPED';
      errors?: string[];
      createdEntityId?: string;
    },
  ): Promise<void> {
    await this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.importBatchRow.update({
        where: { id: rowId },
        data: {
          status: data.status,
          errors: data.errors ?? undefined,
          createdEntityId: data.createdEntityId,
          processedAt: new Date(),
        },
      }),
    );
  }

  private async finalizeBatch(
    organizationId: string,
    importBatchId: string,
    actingUserId: string,
  ): Promise<void> {
    await this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const [imported, failed, skipped] = await Promise.all([
        tx.importBatchRow.count({ where: { organizationId, importBatchId, status: 'IMPORTED' } }),
        tx.importBatchRow.count({ where: { organizationId, importBatchId, status: 'FAILED' } }),
        tx.importBatchRow.count({ where: { organizationId, importBatchId, status: 'SKIPPED' } }),
      ]);
      await tx.importBatch.update({
        where: { id: importBatchId },
        data: {
          status: 'COMPLETE',
          importedRowCount: imported,
          failedRowCount: failed,
          skippedRowCount: skipped,
          completedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        organizationId,
        action: 'Import Batch Completed',
        entityType: 'ImportBatch',
        entityId: importBatchId,
        newValue: { imported, failed, skipped },
        actorUserId: actingUserId,
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
