import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Single shared Redis connection, used for:
 *  - session storage (Phase 1 — immediate revocation on deactivation,
 *    TECHNICAL_ARCHITECTURE.md §3.2/Decision 3)
 *  - BullMQ queues (Phase 7 background jobs, §10)
 *
 * Global so both concerns share one connection pool rather than each
 * module opening its own.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<AppConfig>) => {
        return new Redis(config.get('redis.url', { infer: true }) as string, {
          maxRetriesPerRequest: null, // required by BullMQ's connection contract
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
