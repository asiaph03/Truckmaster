import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../redis/redis.module';
import { QueueRegistryService } from '../queue-health/queue-registry.service';
import { LocationResolutionService } from './services/location-resolution.service';
import { LocationResolutionWorker } from './services/location-resolution.worker';
import { LocationResolutionBackfillService } from './services/location-resolution-backfill.service';
import {
  LOCATION_RESOLUTION_QUEUE,
  LOCATION_RESOLUTION_QUEUE_NAME,
} from './location-resolution.constants';

const LOCATION_RESOLUTION_QUEUE_CONNECTION = 'LOCATION_RESOLUTION_QUEUE_CONNECTION';

/**
 * Dashboard Map Phase 2 — resolves Load current-location (Check Call)
 * and Stop (pickup/intermediate/delivery) city/state pairs against the
 * $0-cost, offline Census-Gazetteer-backed GeocodeCache. Structurally
 * identical to EmailModule: its own duplicated Redis connection for the
 * Queue producer, registered with QueueRegistryService for the existing
 * /api/v1/health/queues endpoint.
 */
@Module({
  providers: [
    LocationResolutionService,
    LocationResolutionWorker,
    LocationResolutionBackfillService,
    {
      provide: LOCATION_RESOLUTION_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => duplicateRedisWithErrorHandler(redis, 'resolve-location-queue'),
      inject: [REDIS_CLIENT],
    },
    {
      provide: LOCATION_RESOLUTION_QUEUE,
      useFactory: (connection: Redis, queueRegistry: QueueRegistryService) => {
        const queue = new Queue(LOCATION_RESOLUTION_QUEUE_NAME, { connection });
        queueRegistry.register(LOCATION_RESOLUTION_QUEUE_NAME, queue);
        return queue;
      },
      inject: [LOCATION_RESOLUTION_QUEUE_CONNECTION, QueueRegistryService],
    },
  ],
  exports: [
    LOCATION_RESOLUTION_QUEUE,
    LocationResolutionService,
    LocationResolutionBackfillService,
  ],
})
export class LocationResolutionModule implements OnModuleDestroy {
  constructor(
    @Inject(LOCATION_RESOLUTION_QUEUE) private readonly queue: Queue,
    @Inject(LOCATION_RESOLUTION_QUEUE_CONNECTION) private readonly queueConnection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.queueConnection.quit();
  }
}
