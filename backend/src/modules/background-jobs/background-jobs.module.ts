import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { CarrierModule } from '../carrier/carrier.module';
import { NotificationModule } from '../notification/notification.module';
import { InvitationExpirationSweepService } from './services/invitation-expiration-sweep.service';
import { QuoteExpirationSweepService } from './services/quote-expiration-sweep.service';
import { CarrierComplianceExpirationSweepService } from './services/carrier-compliance-expiration-sweep.service';
import { ComplianceExpirationNotificationService } from './services/compliance-expiration-notification.service';
import { CheckCallReminderSweepService } from './services/check-call-reminder-sweep.service';
import { LoadLatenessSweepService } from './services/load-lateness-sweep.service';
import { ScheduledJobsWorker } from './services/scheduled-jobs.worker';
import {
  SCHEDULED_JOBS_QUEUE,
  SCHEDULED_JOBS_QUEUE_NAME,
} from './services/background-jobs.constants';

/**
 * Phase 7 — new module. Imports CarrierModule (reuses
 * CarrierEligibilityService unmodified, exactly as DocumentModule already
 * does for the same reason) and NotificationModule (reuses
 * NotificationService via direct calls, Decision 6).
 */
const SCHEDULED_JOBS_QUEUE_CONNECTION = 'SCHEDULED_JOBS_QUEUE_CONNECTION';

@Module({
  imports: [CarrierModule, NotificationModule],
  providers: [
    InvitationExpirationSweepService,
    QuoteExpirationSweepService,
    CarrierComplianceExpirationSweepService,
    ComplianceExpirationNotificationService,
    CheckCallReminderSweepService,
    LoadLatenessSweepService,
    ScheduledJobsWorker,
    {
      provide: SCHEDULED_JOBS_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: SCHEDULED_JOBS_QUEUE,
      useFactory: (connection: Redis) => new Queue(SCHEDULED_JOBS_QUEUE_NAME, { connection }),
      inject: [SCHEDULED_JOBS_QUEUE_CONNECTION],
    },
  ],
})
export class BackgroundJobsModule implements OnModuleDestroy {
  constructor(
    @Inject(SCHEDULED_JOBS_QUEUE) private readonly scheduledJobsQueue: Queue,
    @Inject(SCHEDULED_JOBS_QUEUE_CONNECTION) private readonly scheduledJobsConnection: Redis,
  ) {}

  /** Mirrors every other module's onModuleDestroy exactly. */
  async onModuleDestroy(): Promise<void> {
    await this.scheduledJobsQueue.close();
    await this.scheduledJobsConnection.quit();
  }
}
