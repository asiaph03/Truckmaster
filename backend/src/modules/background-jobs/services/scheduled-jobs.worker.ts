import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { InvitationExpirationSweepService } from './invitation-expiration-sweep.service';
import { QuoteExpirationSweepService } from './quote-expiration-sweep.service';
import { CarrierComplianceExpirationSweepService } from './carrier-compliance-expiration-sweep.service';
import { ComplianceExpirationNotificationService } from './compliance-expiration-notification.service';
import { CheckCallReminderSweepService } from './check-call-reminder-sweep.service';
import { LoadLatenessSweepService } from './load-lateness-sweep.service';
import {
  DAILY_SWEEP_CRON,
  JOB_NAMES,
  OPERATIONAL_SWEEP_INTERVAL_MS,
  SCHEDULED_JOBS_QUEUE,
  SCHEDULED_JOBS_QUEUE_NAME,
} from './background-jobs.constants';

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
  ) {}

  async onModuleInit(): Promise<void> {
    this.workerConnection = this.redis.duplicate();
    this.worker = new Worker(SCHEDULED_JOBS_QUEUE_NAME, async (job) => this.processJob(job.name), {
      connection: this.workerConnection,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Scheduled job ${job?.name} (${job?.id}) failed: ${error.message}`,
        error.stack,
      );
    });

    await this.registerRepeatableJobs();
  }

  private async registerRepeatableJobs(): Promise<void> {
    await this.queue.add(
      JOB_NAMES.INVITATION_EXPIRATION_SWEEP,
      {},
      { repeat: { pattern: DAILY_SWEEP_CRON }, jobId: JOB_NAMES.INVITATION_EXPIRATION_SWEEP },
    );
    await this.queue.add(
      JOB_NAMES.QUOTE_EXPIRATION_SWEEP,
      {},
      { repeat: { pattern: DAILY_SWEEP_CRON }, jobId: JOB_NAMES.QUOTE_EXPIRATION_SWEEP },
    );
    await this.queue.add(
      JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON },
        jobId: JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP,
      },
    );
    await this.queue.add(
      JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS,
      {},
      {
        repeat: { pattern: DAILY_SWEEP_CRON },
        jobId: JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS,
      },
    );
    await this.queue.add(
      JOB_NAMES.CHECK_CALL_REMINDER_SWEEP,
      {},
      {
        repeat: { every: OPERATIONAL_SWEEP_INTERVAL_MS },
        jobId: JOB_NAMES.CHECK_CALL_REMINDER_SWEEP,
      },
    );
    await this.queue.add(
      JOB_NAMES.LOAD_LATENESS_SWEEP,
      {},
      {
        repeat: { every: OPERATIONAL_SWEEP_INTERVAL_MS },
        jobId: JOB_NAMES.LOAD_LATENESS_SWEEP,
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
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
