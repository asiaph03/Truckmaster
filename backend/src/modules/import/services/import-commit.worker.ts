import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../../../common/redis/redis.module';
import { WorkerHeartbeatService } from '../../../common/worker-health/worker-heartbeat.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { AppError } from '../../../common/errors/app-error';
import { ImportAdapterRegistry } from '../adapters/import-adapter.registry';
import { ParentResolutionService } from '../adapters/parent-resolution';
import { ImportDuplicateCache } from '../adapters/types';
import { IMPORT_COMMIT_QUEUE_NAME, ImportCommitJobData } from '../import.constants';

/**
 * Monitoring Phase 4A-15 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content —
 * relevant here in particular since adapter.commit() (below) processes
 * literal spreadsheet row data (names, addresses, contacts).
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

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
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'import-commit-worker');
    this.worker = new Worker<ImportCommitJobData>(
      IMPORT_COMMIT_QUEUE_NAME,
      async (job) => {
        try {
          await this.processJob(job.data);
        } catch (error) {
          const maxAttempts = job.opts.attempts ?? 1;
          if (job.attemptsMade + 1 >= maxAttempts) {
            // Monitoring Phase 4A-4 — job.processedOn is BullMQ's own
            // timestamp for when the job became active.
            const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
            this.logger.error(
              `Import batch ${job.data.importBatchId} (org ${job.data.organizationId}) commit failed after ${maxAttempts} attempts${durationMs !== undefined ? ` (${durationMs}ms)` : ''} — recording FAILED. errorType=${errorTypeOf(error)}`,
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
      // Monitoring Phase 4A-15 — SECURITY: never log error.message/.stack.
      const parts = [
        'event=job_failed',
        'worker=import-commit-worker',
        `queue=${IMPORT_COMMIT_QUEUE_NAME}`,
      ];
      if (job?.id) parts.push(`jobId=${job.id}`);
      if (job?.data?.organizationId) parts.push(`organizationId=${job.data.organizationId}`);
      parts.push(
        `attempt=${job?.attemptsMade ?? 'unknown'}`,
        `maxAttempts=${job?.opts?.attempts ?? 'unknown'}`,
        `errorType=${errorTypeOf(error)}`,
      );
      this.logger.error(parts.join(' '));
      this.heartbeat.recordActivity('import-commit-worker', 'failed');
    });
    this.worker.on('active', () => this.heartbeat.recordActivity('import-commit-worker', 'active'));
    this.worker.on('completed', (job) => {
      const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
      this.logger.log(
        `Import commit job ${job.id} (org ${job.data.organizationId}) completed${durationMs !== undefined ? ` in ${durationMs}ms` : ''}.`,
      );
      this.heartbeat.recordActivity('import-commit-worker', 'completed');
    });
    this.worker.on('error', (error) => {
      // Monitoring Phase 4A-15 — SECURITY: connection-level handler, no
      // Job available — never log error.message/.stack, never fabricate
      // jobId/organizationId/attempt fields.
      this.logger.error(
        `event=worker_error worker=import-commit-worker queue=${IMPORT_COMMIT_QUEUE_NAME} errorType=${errorTypeOf(error)}`,
      );
      this.heartbeat.recordError('import-commit-worker', 'error');
    });
    // Monitoring Phase 4A-5 — purely observational; deliberately does NOT
    // touch WorkerHeartbeatService (see malware-scan.worker.ts for the
    // full rationale). No organizationId available from this event.
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Import commit job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('import-commit-worker', () => this.worker!.isRunning());
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
          // Monitoring Phase 4A-15 — SECURITY: adapter.commit() processes
          // literal spreadsheet row data (names, addresses, contacts) —
          // never log error.message/.stack here.
          this.logger.error(
            `Unexpected error importing row ${row.rowNumber} of batch ${batch.id}. errorType=${errorTypeOf(error)}`,
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
    this.heartbeat.unregister('import-commit-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
