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
 * Monitoring Phase 4A-15 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content
 * (Anthropic's APIError.message is confirmed, per the Phase 4A-14 audit,
 * to be built directly from the API's own JSON error response body).
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

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
          await this.processJob(job.data, job.id!);
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
            // Monitoring Phase 4A-14 — SECURITY: never pass the Error
            // object, its .stack, .message, or String(error) here. The
            // active extractor (AnthropicRateConfirmationExtractor) can
            // throw an APIError whose .message/.stack are built directly
            // from the Anthropic API's own JSON error response body
            // (confirmed by reading the installed SDK's source), which can
            // plausibly reference this document's content. The Anthropic
            // dependency layer already emits its own safe, categorized
            // event=anthropic_operation log on failure — this log is
            // intentionally metadata-only so it isn't duplicated here.
            // `message` (still passed to jobStore.markFailed below) is
            // unchanged — that's the existing, approved, access-controlled
            // user-facing failure reason shown in the New Load form, not a
            // shared application log.
            this.logger.error(
              `Rate Confirmation extraction ${job.data.extractionId} (org ${job.data.organizationId}) failed after ${maxAttempts} attempts${durationMs !== undefined ? ` (${durationMs}ms)` : ''}.`,
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
      // Monitoring Phase 4A-15 — SECURITY: never log error.message/.stack.
      // Preserves the Phase 4A-14 finding (Anthropic APIError.message is
      // response-body-derived) via a distinct code path — this generic
      // hook fires on every failed attempt, not only the final one.
      const parts = [
        'event=job_failed',
        'worker=rate-confirmation-extraction-worker',
        `queue=${RATE_CONFIRMATION_EXTRACTION_QUEUE_NAME}`,
      ];
      if (job?.id) parts.push(`jobId=${job.id}`);
      if (job?.data?.organizationId) parts.push(`organizationId=${job.data.organizationId}`);
      parts.push(
        `attempt=${job?.attemptsMade ?? 'unknown'}`,
        `maxAttempts=${job?.opts?.attempts ?? 'unknown'}`,
        `errorType=${errorTypeOf(error)}`,
      );
      this.logger.error(parts.join(' '));
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
      // Monitoring Phase 4A-15 — SECURITY: connection-level handler, no
      // Job available — never log error.message/.stack, never fabricate
      // jobId/organizationId/attempt fields.
      this.logger.error(
        `event=worker_error worker=rate-confirmation-extraction-worker queue=${RATE_CONFIRMATION_EXTRACTION_QUEUE_NAME} errorType=${errorTypeOf(error)}`,
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

  private async processJob(
    data: RateConfirmationExtractionJobData,
    jobId: string,
  ): Promise<void> {
    await this.jobStore.markInProgress(data.organizationId, data.extractionId);

    const pdfBytes = await this.storage.getObject(data.storageKey, {
      organizationId: data.organizationId,
      jobId,
    });
    const outcome = await this.extractor.extract(pdfBytes, data.extractionId, {
      organizationId: data.organizationId,
      jobId,
    });

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
