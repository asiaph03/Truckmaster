import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../redis/redis.module';
import { WorkerHeartbeatService } from '../worker-health/worker-heartbeat.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { EMAIL_SENDER, EmailAttachment, IEmailSender } from './email-sender.interface';
import { EMAIL_QUEUE_NAME, EmailJobData } from './email-queue.constants';

/**
 * Frontend Phase 16 — the async worker side of transactional email
 * (TECHNICAL_ARCHITECTURE.md §10's "Async, immediate" requirement,
 * previously never actually built — every send call was synchronous
 * before this phase). Structurally identical to MalwareScanWorker/the
 * three PDF-generation workers: its own duplicated Redis connection,
 * `.quit()`'d in onModuleDestroy.
 *
 * A business mutation (Invoice Sent, Rate Confirmation Generated, an
 * invitation created, Organization created) is never affected by this
 * worker's outcome — by the time a job reaches here, the triggering
 * mutation already committed; enqueueing only fails if Redis itself is
 * unreachable, never because the email provider is slow/down.
 */
@Injectable()
export class EmailSendWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailSendWorker.name);
  private worker?: Worker<EmailJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(EMAIL_SENDER) private readonly emailSender: IEmailSender,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'email-send-worker');
    this.worker = new Worker<EmailJobData>(
      EMAIL_QUEUE_NAME,
      async (job) => {
        try {
          const attachments = await this.resolveAttachment(job.data);
          await this.emailSender.send(
            {
              to: job.data.to,
              subject: job.data.subject,
              body: job.data.body,
              ...(attachments ? { attachments } : {}),
            },
            { organizationId: job.data.organizationId, jobId: job.id! },
          );
        } catch (error) {
          // Frontend Phase 16 — same retry-then-terminal-outcome pattern
          // as the malware-scan/PDF-generation workers: only the final
          // configured attempt writes a terminal record (here, an audit
          // entry — email has no Document-style status field of its own
          // to update). actorType: 'SYSTEM' + an explicit organizationId
          // is the same worker-safe AuditService.record pattern already
          // proven by RateConfirmationGenerationWorker et al. — no
          // RequestContextStore dependency, safe with no request in flight.
          const maxAttempts = job.opts.attempts ?? 1;
          if (job.attemptsMade + 1 >= maxAttempts) {
            // Monitoring Phase 4A-1 — deliberately no recipient/subject here
            // (PII in a shared application log); that detail still lands in
            // the Audit DB record below (recordFailure), an access-
            // controlled location, unchanged from before this fix.
            // Monitoring Phase 4A-4 — job.processedOn is BullMQ's own
            // timestamp for when the job became active; no timing state of
            // our own to maintain. Optional per BullMQ's types.
            const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
            this.logger.error(
              `Email job ${job.id} (org ${job.data.organizationId}) failed after ${maxAttempts} attempts${durationMs !== undefined ? ` (${durationMs}ms)` : ''}.`,
              error instanceof Error ? error.stack : String(error),
            );
            await this.recordFailure(job.data, error);
            return;
          }
          throw error;
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Email send job ${job?.id} (org ${job?.data.organizationId}) failed: ${error.message}`,
        error.stack,
      );
      this.heartbeat.recordActivity('email-send-worker', 'failed');
    });
    this.worker.on('active', () => this.heartbeat.recordActivity('email-send-worker', 'active'));
    this.worker.on('completed', (job) => {
      const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
      this.logger.log(
        `Email job ${job.id} (org ${job.data.organizationId}) completed${durationMs !== undefined ? ` in ${durationMs}ms` : ''}.`,
      );
      this.heartbeat.recordActivity('email-send-worker', 'completed');
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Email send worker connection error: ${error.message}`, error.stack);
      this.heartbeat.recordError('email-send-worker', 'error');
    });
    // Monitoring Phase 4A-5 — purely observational; deliberately does NOT
    // touch WorkerHeartbeatService (see malware-scan.worker.ts for the
    // full rationale). No organizationId available from this event.
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Email job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('email-send-worker', () => this.worker!.isRunning());
  }

  /**
   * Driver Dispatch Email feature — resolves the referenced Document
   * (never trusted blindly: re-scoped to the job's own organizationId,
   * exactly like every other organization-scoped read in this codebase)
   * and reads its bytes from storage only at send time, so the PDF
   * itself never sits in a Redis job payload. Returns undefined (not an
   * empty array) when the job carries no attachment reference, so every
   * pre-existing email job is completely unaffected. Any failure here
   * (document missing, object missing from storage) propagates to the
   * caller's existing try/catch — handled by the same retry-then-
   * terminal-failure path as any other send failure; the email is never
   * sent without its required attachment.
   */
  private async resolveAttachment(data: EmailJobData): Promise<EmailAttachment[] | undefined> {
    if (!data.attachmentDocumentId) return undefined;

    const document = await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.document.findFirst({
        where: { id: data.attachmentDocumentId, organizationId: data.organizationId },
      }),
    );
    if (!document) {
      throw new Error(`Email attachment document ${data.attachmentDocumentId} was not found.`);
    }

    const content = await this.storage.getObject(document.fileStorageKey);
    return [{ filename: document.fileName, content, contentType: document.mimeType }];
  }

  private async recordFailure(data: EmailJobData, error: unknown): Promise<void> {
    await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      this.audit.record(tx, {
        organizationId: data.organizationId,
        action: 'Email Delivery Failed',
        entityType: data.entityType,
        entityId: data.entityId,
        newValue: {
          to: data.to,
          subject: data.subject,
          error: error instanceof Error ? error.message : String(error),
        },
        actorType: 'SYSTEM',
        actorUserId: null,
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.heartbeat.unregister('email-send-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
