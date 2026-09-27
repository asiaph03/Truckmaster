import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT, duplicateRedisWithErrorHandler } from '../../redis/redis.module';
import { WorkerHeartbeatService } from '../../worker-health/worker-heartbeat.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationResolutionService } from './location-resolution.service';
import {
  LOCATION_RESOLUTION_QUEUE_NAME,
  LocationResolutionJobData,
} from '../location-resolution.constants';

/**
 * Same class-name-only error identifier convention as every other
 * worker in this codebase (see EmailSendWorker) — never
 * error.message/.stack in a log line.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Dashboard Map Phase 2 — resolves BOTH CheckCall and Stop locations
 * through the same $0-cost, offline-only path (LocationResolutionService
 * → GeocodeCache, seeded from the Census Gazetteer; no external
 * geocoder call exists in this phase). Structurally identical to
 * EmailSendWorker/MalwareScanWorker: its own duplicated Redis
 * connection, heartbeat-registered, closed in onModuleDestroy.
 *
 * A cache MISS is not a job failure — it is the legitimate, honest
 * "this city/state isn't in our dataset yet" outcome (resolutionStatus
 * stays/becomes UNRESOLVED, never a guessed coordinate). Only a genuine
 * exception (DB/Redis hiccup) is retried via BullMQ's attempts/backoff.
 */
@Injectable()
export class LocationResolutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocationResolutionWorker.name);
  private worker?: Worker<LocationResolutionJobData>;
  private workerConnection?: Redis;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly locationResolution: LocationResolutionService,
    private readonly heartbeat: WorkerHeartbeatService,
  ) {}

  onModuleInit(): void {
    this.workerConnection = duplicateRedisWithErrorHandler(this.redis, 'resolve-location-worker');
    this.worker = new Worker<LocationResolutionJobData>(
      LOCATION_RESOLUTION_QUEUE_NAME,
      async (job) => {
        const resolved = await this.locationResolution.resolve(job.data.city, job.data.state);

        if (job.data.entityType === 'CHECK_CALL') {
          await this.applyToCheckCall(job.data, resolved);
        } else {
          await this.applyToStop(job.data, resolved);
        }
      },
      { connection: this.workerConnection },
    );

    this.worker.on('failed', (job, error) => {
      const parts = [
        'event=job_failed',
        'worker=resolve-location-worker',
        `queue=${LOCATION_RESOLUTION_QUEUE_NAME}`,
      ];
      if (job?.id) parts.push(`jobId=${job.id}`);
      if (job?.data?.organizationId) parts.push(`organizationId=${job.data.organizationId}`);
      parts.push(
        `attempt=${job?.attemptsMade ?? 'unknown'}`,
        `maxAttempts=${job?.opts?.attempts ?? 'unknown'}`,
        `errorType=${errorTypeOf(error)}`,
      );
      this.logger.error(parts.join(' '));
      this.heartbeat.recordActivity('resolve-location-worker', 'failed');
    });
    this.worker.on('active', () =>
      this.heartbeat.recordActivity('resolve-location-worker', 'active'),
    );
    this.worker.on('completed', () =>
      this.heartbeat.recordActivity('resolve-location-worker', 'completed'),
    );
    this.worker.on('error', (error) => {
      this.logger.error(
        `event=worker_error worker=resolve-location-worker queue=${LOCATION_RESOLUTION_QUEUE_NAME} errorType=${errorTypeOf(error)}`,
      );
      this.heartbeat.recordError('resolve-location-worker', 'error');
    });
    this.worker.on('stalled', (jobId, prev) => {
      this.logger.warn(`Location-resolution job ${jobId} stalled (was ${prev}).`);
    });

    this.heartbeat.register('resolve-location-worker', () => this.worker!.isRunning());
  }

  private async applyToCheckCall(
    data: LocationResolutionJobData,
    resolved: { lat: number; lng: number; source: string } | null,
  ): Promise<void> {
    // CheckCall/Load are RLS-protected tenant tables — every read/write
    // must run inside withTenantTransaction, same as every other worker
    // touching business data (see EmailSendWorker.resolveAttachment).
    await this.prisma.withTenantTransaction(data.organizationId, async (tx) => {
      const checkCall = await tx.checkCall.update({
        where: { id: data.entityId },
        data: resolved
          ? {
              resolvedLat: resolved.lat,
              resolvedLng: resolved.lng,
              resolutionStatus: 'RESOLVED_DATASET',
              resolutionSource: resolved.source,
              resolvedAt: new Date(),
            }
          : {
              resolutionStatus: 'UNRESOLVED',
              resolvedAt: new Date(),
            },
        select: { loadId: true },
      });

      if (!resolved || !data.asOfLoadUpdatedAt) return;

      // Guard: only write Load's denormalized current lat/lng if no
      // later Check Call has been logged for this load since this job
      // was enqueued (see LocationResolutionJobData.asOfLoadUpdatedAt's
      // own doc comment for why this specific field is the right guard).
      await tx.load.updateMany({
        where: {
          id: checkCall.loadId,
          currentLocationUpdatedAt: new Date(data.asOfLoadUpdatedAt),
        },
        data: { currentLocationLat: resolved.lat, currentLocationLng: resolved.lng },
      });
    });
  }

  private async applyToStop(
    data: LocationResolutionJobData,
    resolved: { lat: number; lng: number; source: string } | null,
  ): Promise<void> {
    // No Load-level "latest wins" concept for Stop — each stop is its
    // own row, addressed by its own id, never overwritten by another
    // stop's resolution.
    await this.prisma.withTenantTransaction(data.organizationId, (tx) =>
      tx.stop.update({
        where: { id: data.entityId },
        data: resolved
          ? {
              resolvedLat: resolved.lat,
              resolvedLng: resolved.lng,
              resolutionStatus: 'RESOLVED_DATASET',
              resolutionSource: resolved.source,
              resolvedAt: new Date(),
            }
          : {
              resolutionStatus: 'UNRESOLVED',
              resolvedAt: new Date(),
            },
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.heartbeat.unregister('resolve-location-worker');
    await this.worker?.close();
    await this.workerConnection?.quit();
  }
}
