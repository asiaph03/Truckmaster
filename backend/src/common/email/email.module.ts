import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { EMAIL_SENDER } from './email-sender.interface';
import { PostmarkEmailSender } from './postmark-email-sender';
import { EmailSendWorker } from './email-send.worker';
import { EMAIL_QUEUE, EMAIL_QUEUE_NAME } from './email-queue.constants';

/**
 * Internal token for the Queue producer's own duplicated Redis connection
 * — same reasoning as MALWARE_SCAN_QUEUE_CONNECTION/
 * RATE_CONFIRMATION_QUEUE_CONNECTION: kept separate so onModuleDestroy
 * can explicitly `.quit()` it.
 */
const EMAIL_QUEUE_CONNECTION = 'EMAIL_QUEUE_CONNECTION';

/**
 * Frontend Phase 16 — the single, shared home for transactional email.
 * Consolidates what was previously three separate, duplicate
 * `{ provide: EMAIL_SENDER, useClass: ConsoleEmailSender }` registrations
 * (billing.module.ts, identity.module.ts, quote-load.module.ts) into one
 * registration here; those three modules now import EmailModule and
 * inject EMAIL_QUEUE instead of EMAIL_SENDER directly, enqueueing a job
 * rather than calling the provider synchronously — see EmailSendWorker's
 * own doc comment for why.
 */
@Module({
  providers: [
    EmailSendWorker,
    { provide: EMAIL_SENDER, useClass: PostmarkEmailSender },
    {
      provide: EMAIL_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: EMAIL_QUEUE,
      useFactory: (connection: Redis) => new Queue(EMAIL_QUEUE_NAME, { connection }),
      inject: [EMAIL_QUEUE_CONNECTION],
    },
  ],
  exports: [EMAIL_QUEUE],
})
export class EmailModule implements OnModuleDestroy {
  constructor(
    @Inject(EMAIL_QUEUE) private readonly emailQueue: Queue,
    @Inject(EMAIL_QUEUE_CONNECTION) private readonly emailQueueConnection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.emailQueue.close();
    await this.emailQueueConnection.quit();
  }
}
