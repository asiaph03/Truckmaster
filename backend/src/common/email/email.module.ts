import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AppConfig } from '../../config/configuration';
import { REDIS_CLIENT } from '../redis/redis.module';
import { EMAIL_SENDER, IEmailSender } from './email-sender.interface';
import { PostmarkEmailSender } from './postmark-email-sender';
import { NoopEmailSender } from './noop-email-sender';
import { EmailSendWorker } from './email-send.worker';
import { EMAIL_QUEUE, EMAIL_QUEUE_NAME } from './email-queue.constants';

/**
 * Task #6 — pure selection logic, exported and unit-tested directly
 * (email.module.spec.ts) without needing to boot the Nest DI container.
 * `nodeEnv` only ever equals `'test'` when
 * test/setup-e2e-env.ts explicitly sets it (see that file) — production
 * and every local-dev NODE_ENV value are unaffected, so this changes
 * nothing about real deployments.
 */
export function chooseEmailSender(
  nodeEnv: string,
  postmark: PostmarkEmailSender,
  noop: NoopEmailSender,
): IEmailSender {
  return nodeEnv === 'test' ? noop : postmark;
}

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
    PostmarkEmailSender,
    NoopEmailSender,
    {
      provide: EMAIL_SENDER,
      useFactory: (
        config: ConfigService<AppConfig>,
        postmark: PostmarkEmailSender,
        noop: NoopEmailSender,
      ) => chooseEmailSender(config.get('nodeEnv', { infer: true })!, postmark, noop),
      inject: [ConfigService, PostmarkEmailSender, NoopEmailSender],
    },
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
