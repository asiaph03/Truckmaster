import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsOptions, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../../../common/redis/redis.module';
import { WorkerHeartbeatService } from '../../../common/worker-health/worker-heartbeat.service';
import { InvitationExpirationSweepService } from './invitation-expiration-sweep.service';
import { QuoteExpirationSweepService } from './quote-expiration-sweep.service';
import { CarrierComplianceExpirationSweepService } from './carrier-compliance-expiration-sweep.service';
import { ComplianceExpirationNotificationService } from './compliance-expiration-notification.service';
import { CheckCallReminderSweepService } from './check-call-reminder-sweep.service';
import { LoadLatenessSweepService } from './load-lateness-sweep.service';
import { BUSINESS_TIMEZONE } from '../../../common/timezone/business-timezone';
import { SweepHealthService } from '../../../common/sweep-health/sweep-health.service';
import {
  DAILY_SWEEP_CRON,
  JOB_NAMES,
  OPERATIONAL_SWEEP_INTERVAL_MS,
  SCHEDULED_JOBS_QUEUE,
  SCHEDULED_JOBS_QUEUE_NAME,
} from './background-jobs.constants';

/**
 * Monitoring Phase 4A-6 — retention only; no change to repeat cadence, job
 * names, or dedupe behavior. Completed: ~1 day / 200 entries, matching this
 * queue's own ~196/day volume (2 sweeps every 15 min + 4 daily), with zero
 * business value in keeping more (payload is always {}, no code depends on
 * it). Failed: 7 days / 500 entries — this queue has no attempts/backoff,
 * so 'failed' is always the terminal signal for a sweep, worth a real
 * postmortem window in case of a spike.
 */
export const SCHEDULED_JOBS_RETENTION: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { count: 200, age: 86400 },
  removeOnFail: { count: 500, age: 604800 },
};

/**
 * Monitoring Phase 4A-15 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content.
 * This worker's generic 'failed' handler is the sole failure signal for
 * all 6 sweep services it dispatches to (no per-processor try/catch).
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Owns the single shared `scheduled-jobs` queue/worker pair and registers
 * the Phase 7 repeatable jobs plus the Operational Alerts feature's two
 * (check-call reminder/due-soon, load-lateness) sweeps on it
 * (Decision 7 — BullMQ's own
 * `repeat` option, no new scheduler dependency). Structurally mirrors
 * every other worker in this codebase (own duplicated Redis connection,
 * `.quit()`'d in onModuleDestroy) — the only new element is calling
 * `queue.add(..., { repeat })` in onModuleInit, which BullMQ dedupes by
 * job name + repeat options, so it's safe to run on every app startup
 * without creating duplicate schedules.
 */
@Injectable()
export class ScheduledJobsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledJobsWorker.name);
  private worker?: Worker;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(SCHEDULED_JOBS_QUEUE) private readonly queue: Queue,
    private readonly invitationExpirationSweep: InvitationExpirationSweepService,
    private readonly quoteExpirationSweep: QuoteExpirationSweepService,
    private readonly carrierComplianceExpirationSweep: CarrierComplianceExpirationSweepService,
    private readonly complianceExpirationNotification: ComplianceExpirationNotificationService,
    private readonly checkCallReminderSweep: CheckCallReminderSweepService,
    private readonly loadLatenessSweep: LoadLatenessSweepService,
    private readonly heartbeat: WorkerHeartbeatService,
    private readonly sweepHealth: SweepHealthService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'scheduled-jobs-worker');
    this.worker = new Worker(SCHEDULED_JOBS_QUEUE_NAME, async (job) => this.processJob(job.name), {
      connection: this.workerConnection,
    });

    this.worker.on('failed', (job, error) => {
      // Monitoring Phase 4A-4 — this queue has no attempts/backoff
      // configured (see registerRepeatableJobs below), so this generic
      // hook IS the terminal/final-attempt failure signal for a sweep —
      // there is no separate per-processor try/catch to attach duration
      // to, unlike the other 7 workers. job.processedOn is BullMQ's own
      // timestamp for when the job became active.
      // Monitoring Phase 4A-15 — SECURITY: never log error.message/.stack.
      // No organizationId here by design (see the 'completed' handler
      // below) — this queue's job payload is always {}.
      const durationMs = job?.processedOn ? Date.now() - job.processedOn : undefined;
      const parts = [
        'event=job_failed',
        'worker=scheduled-jobs-worker',
        `queue=${SCHEDULED_JOBS_QUEUE_NAME}`,
      ];
      if (job?.name) parts.push(`jobName=${job.name}`);
      if (job?.id) parts.push(`jobId=${job.id}`);
      parts.push(
        `attempt=${job?.attemptsMade ?? 'unknown'}`,
        `maxAttempts=${job?.opts?.attempts ?? 'unknown'}`,
      );
      if (durationMs !== undefined) parts.push(`durationMs=${durationMs}`);
      parts.push(`errorType=${errorTypeOf(error)}`);
      this.logger.error(parts.join(' '));
      this.heartbeat.recordActivity('scheduled-jobs-worker', 'failed');
      // Monitoring Phase 4A-23D — best-effort; a Redis failure here must
      // never affect this job's own already-terminal outcome, so this is
      // deliberately not awaited. SweepHealthService itself never rejects,
      // but the .catch() here is defense-in-depth against that contract
      // ever changing (an unhandled rejection would otherwise crash the
      // process — confirmed by this phase's own test suite). lastSuccessAt
      // is intentionally left untouched on failure.
      if (job?.name) {
        this.sweepHealth.recordFailure(job.name, job.processedOn ?? Date.now()).catch(() => undefined);
      }
    });
    this.worker.on('active', () => this.heartbeat.recordActivity('scheduled-jobs-worker', 'active'));
    this.worker.on('completed', (job) => {
      // No organizationId here by design — this queue's job payload is
      // always {} (a sweep spans every organization), matching every
      // other log line for this worker.
      const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
      this.logger.log(
        `Scheduled job ${job.name} (${job.id}) completed${durationMs !== undefined ? ` in ${durationMs}ms` : ''}.`,
      );
      this.heartbeat.recordActivity('scheduled-jobs-worker', 'completed');
      // Monitoring Phase 4A-23D — best-effort, not awaited; see the
      // 'failed' handler's own comment above for why the .catch() exists.
      this.sweepHealth.recordSuccess(job.name, job.processedOn ?? Date.now()).catch(() => undefined);
    });
    this.worker.on('error', (error) => {
      // Monitoring Phase 4A-15 — SECURITY: connection-level handler, no
      // Job available — never log error.message/.stack, never fabricate
      // jobId/attempt fields.
      this.logger.error(
        `event=worker_error worker=scheduled-jobs-worker queue=${SCHEDULED_JOBS_QUEUE_NAME} errorType=${errorTypeOf(error)}`,
      );
      this.heartbeat.recordError('scheduled-jobs-worker', 'error');
    });
    // Monitoring Phase 4A-5 — purely observational; deliberately does NOT
    // touch WorkerHeartbeatService (see malware-scan.worker.ts for the
    // full rationale). No organizationId available from this event (and
    // this queue's job payload is always {} anyway).
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Scheduled job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('scheduled-jobs-worker', () => this.worker!.isRunning());

    await this.registerRepeatableJobs();
  }

  private async registerRepeatableJobs(): Promise<void> {
    await this.queue.add(
      JOB_NAMES.INVITATION_EXPIRATION_SWEEP,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON, tz: BUSINESS_TIMEZONE },
        jobId: JOB_NAMES.INVITATION_EXPIRATION_SWEEP,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
    await this.queue.add(
      JOB_NAMES.QUOTE_EXPIRATION_SWEEP,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON, tz: BUSINESS_TIMEZONE },
        jobId: JOB_NAMES.QUOTE_EXPIRATION_SWEEP,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
    await this.queue.add(
      JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON, tz: BUSINESS_TIMEZONE },
        jobId: JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
    await this.queue.add(
      JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON, tz: BUSINESS_TIMEZONE },
        jobId: JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
    await this.queue.add(
      JOB_NAMES.CHECK_CALL_REMINDER_SWEEP,
      {},
      {
        repeat: { every: OPERATIONAL_SWEEP_INTERVAL_MS },
        jobId: JOB_NAMES.CHECK_CALL_REMINDER_SWEEP,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
    await this.queue.add(
      JOB_NAMES.LOAD_LATENESS_SWEEP,
      {},
      {
        repeat: { every: OPERATIONAL_SWEEP_INTERVAL_MS },
        jobId: JOB_NAMES.LOAD_LATENESS_SWEEP,
        ...SCHEDULED_JOBS_RETENTION,
      },
    );
  }

  private async processJob(jobName: string): Promise<void> {
    switch (jobName) {
      case JOB_NAMES.INVITATION_EXPIRATION_SWEEP:
        return this.invitationExpirationSweep.run();
      case JOB_NAMES.QUOTE_EXPIRATION_SWEEP:
        return this.quoteExpirationSweep.run();
      case JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP:
        return this.carrierComplianceExpirationSweep.run();
      case JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS:
        return this.complianceExpirationNotification.run();
      case JOB_NAMES.CHECK_CALL_REMINDER_SWEEP:
        return this.checkCallReminderSweep.run();
      case JOB_NAMES.LOAD_LATENESS_SWEEP:
        return this.loadLatenessSweep.run();
      default:
        this.logger.warn(`Unknown scheduled job name: ${jobName}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.heartbeat.unregister('scheduled-jobs-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
