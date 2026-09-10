import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Monitoring Phase 4A-1 — every ioredis client (the primary connection and
 * every `.duplicate()`) is its own EventEmitter; an `'error'` event with no
 * listener is a Node fatal error, so a transient Redis blip could crash the
 * whole process instead of just failing the in-flight operation(s).
 * `label` identifies which module/worker owns the connection, so a
 * simultaneous burst of errors during a real outage is still attributable
 * per-connection rather than one undifferentiated flood. Split out from
 * duplicateRedisWithErrorHandler() below so both it and the primary
 * client's own construction share one implementation, and so this logic
 * is unit-testable against a plain EventEmitter-like stub without needing
 * a real ioredis connection.
 */
export function attachRedisErrorHandler(client: Redis, label: string): void {
  client.on('error', (err) => {
    new Logger('Redis').error(`Redis connection error (${label}): ${err.message}`, err.stack);
  });
}

/**
 * The standard shape every `.duplicate()` call site in the codebase must
 * go through instead of calling `redis.duplicate()` directly — see
 * attachRedisErrorHandler's own comment above for why.
 */
export function duplicateRedisWithErrorHandler(redis: Redis, label: string): Redis {
  const duplicate = redis.duplicate();
  attachRedisErrorHandler(duplicate, label);
  return duplicate;
}

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
        const client = new Redis(config.get('redis.url', { infer: true }) as string, {
          maxRetriesPerRequest: null, // required by BullMQ's connection contract
        });
        // Monitoring Phase 4A-1 — see attachRedisErrorHandler's own comment
        // above; the primary client needs the same defensive listener
        // since it's an independent EventEmitter too.
        attachRedisErrorHandler(client, 'primary');
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * A plain ioredis instance returned from a `useFactory` provider is not
   * itself a Nest-lifecycle-aware object — Nest never calls anything on it
   * automatically. Without this, the connection's open TCP socket is the
   * single biggest reason `app.close()` (and therefore Jest's own process)
   * never exits cleanly after an e2e run (empirically confirmed — every
   * e2e run in this repo has shown "Jest did not exit one second after the
   * test run has completed" until this fix).
   */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
