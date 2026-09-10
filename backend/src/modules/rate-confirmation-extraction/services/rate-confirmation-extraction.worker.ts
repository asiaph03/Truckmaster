import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../../../common/redis/redis.module';
import { WorkerHeartbeatService } from '../../../common/worker-health/worker-heartbeat.service';
import { StorageService } from '../../../common/storage/storage.service';
import {
  RATE_CONFIRMATION_EXTRACTOR,
  IRateConfirmationExtractor,
} from '../rate-confirmation-extractor.interface';
import {
  RATE_CONFIRMATION_EXTRACTION_QUEUE_NAME,
  RateConfirmationExtractionJobData,
} from '../rate-confirmation-extraction.constants';
import { RateConfirmationExtractionJobStore } from './rate-confirmation-extraction-job-store.service';

/**
 * Rate Confirmation → New Load auto-populate feature — the async worker
 * side of extraction. Runs in-process (same modular monolith, no separate
 * worker deployment — matches every other worker in this codebase), off
 * the request path. Structurally identical to MalwareScanWorker /
 * RateConfirmationGenerationWorker: its own duplicated Redis connection
 * (never the shared REDIS_CLIENT directly — BullMQ's Worker needs a
 * dedicated blocking connection), explicitly `.quit()`'d in
 * onModuleDestroy so it never becomes the open-handle-keeps-Jest-alive
 * bug already fixed for the other two queues in this codebase.
 *
 * Deliberately does NOT inject DocumentService/PrismaService for writing
 * a result back to Postgres — the extraction result is scratch state,
 * held only in Redis via RateConfirmationExtractionJobStore (approved
 * design decision, see rate-confirmation-extraction.constants.ts).
 */
@Injectable()
export class RateConfirmationExtractionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateConfirmationExtractionWorker.name);
  private worker?: Worker<RateConfirmationExtractionJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(RATE_CONFIRMATION_EXTRACTOR) private readonly extractor: IRateConfirmationExtractor,
    private readonly storage: StorageService,
    private readonly jobStore: RateConfirmationExtractionJobStore,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'rate-confirmation-extraction-worker');
    this.worker = new Worker<RateConfirmationExtractionJobData>(
      RATE_CONFIRMATION_EXTRACTION_QUEUE_NAME,
      async (job) => {
        try {
          await this.processJob(job.data);
        } catch (error) {
          // Same retry-then-terminal-status pattern as MalwareScanWorker
          // and RateConfirmationGenerationWorker: only the final
          // configured attempt resolves to a terminal FAILED status;
          // every earlier attempt rethrows so BullMQ's own
          // attempts/backoff (RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS)
          // retries the job.
          const maxAttempts = job.opts.attempts ?? 1;
          const message = error instanceof Error ? error.message : String(error);
          if (job.attemptsMade + 1 >= maxAttempts) {
            // Monitoring Phase 4A-4 — job.processedOn is BullMQ's own
            // timestamp for when the job became active.
            const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
            this.logger.error(
              `Rate Confirmation extraction ${job.data.extractionId} (org ${job.data.organizationId}) failed after ${maxAttempts} attempts${durationMs !== undefined ? ` (${durationMs}ms)` : ''}.`,
              error instanceof Error ? error.stack : String(error),
            );
            await this.jobStore.markFailed(job.data.organizationId, job.data.extractionId, message);
            return;
          }
          throw error;
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Rate Confirmation extraction job ${job?.id} (org ${job?.data.organizationId}) failed: ${error.message}`,
        error.stack,
      );
      this.heartbeat.recordActivity('rate-confirmation-extraction-worker', 'failed');
    });
    this.worker.on('active', () =>
      this.heartbeat.recordActivity('rate-confirmation-extraction-worker', 'active'),
    );
    this.worker.on('completed', (job) => {
      const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
      this.logger.log(
        `Rate Confirmation extraction job ${job.id} (org ${job.data.organizationId}) completed${durationMs !== undefined ? ` in ${durationMs}ms` : ''}.`,
      );
      this.heartbeat.recordActivity('rate-confirmation-extraction-worker', 'completed');
    });
    this.worker.on('error', (error) => {
      this.logger.error(
        `Rate Confirmation extraction worker connection error: ${error.message}`,
        error.stack,
      );
      this.heartbeat.recordError('rate-confirmation-extraction-worker', 'error');
    });
    // Monitoring Phase 4A-5 — purely observational; deliberately does NOT
    // touch WorkerHeartbeatService (see malware-scan.worker.ts for the
    // full rationale). No organizationId available from this event.
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Rate Confirmation extraction job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('rate-confirmation-extraction-worker', () => this.worker!.isRunning());
  }

  private async processJob(data: RateConfirmationExtractionJobData): Promise<void> {
    await this.jobStore.markInProgress(data.organizationId, data.extractionId);

    const pdfBytes = await this.storage.getObject(data.storageKey);
    const outcome = await this.extractor.extract(pdfBytes, data.extractionId);

    // Never log the extracted content itself — only that extraction
    // completed and whether it was a normal result or a multi-load
    // rejection (matches MalwareScanWorker's own metadata-only logging).
    this.logger.log(
      `Rate Confirmation extraction ${data.extractionId} (org ${data.organizationId}) completed (multiLoadDetected=${outcome.multiLoadDetected}).`,
    );

    if (outcome.multiLoadDetected) {
      await this.jobStore.markFailed(
        data.organizationId,
        data.extractionId,
        'This Rate Confirmation appears to contain multiple loads. Please upload one Rate Confirmation for a single load.',
      );
      return;
    }

    await this.jobStore.markComplete(data.organizationId, data.extractionId, outcome.data);
  }

  async onModuleDestroy(): Promise<void> {
    this.heartbeat.unregister('rate-confirmation-extraction-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
