import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
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
  ) {}

  onModuleInit(): void {
    this.workerConnection = this.redis.duplicate();
    this.worker = new Worker<EmailJobData>(
      EMAIL_QUEUE_NAME,
      async (job) => {
        try {
          const attachments = await this.resolveAttachment(job.data);
          await this.emailSender.send({
            to: job.data.to,
            subject: job.data.subject,
            body: job.data.body,
            ...(attachments ? { attachments } : {}),
          });
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
            this.logger.error(
              `Email to ${job.data.to} ("${job.data.subject}") failed after ${maxAttempts} attempts.`,
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
      this.logger.error(`Email send job ${job?.id} failed: ${error.message}`, error.stack);
    });
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
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
