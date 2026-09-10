import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  QueueCountsSnapshot,
  QueueRegistryService,
} from '../common/queue-health/queue-registry.service';

interface QueueHealthResponse {
  queues: QueueCountsSnapshot[];
}

interface QueueHealthErrorResponse {
  error: string;
  queues: [];
}

/**
 * Monitoring Phase 4A-6 — read-only queue depth/backlog diagnostic,
 * separate from /health by design (mirrors WorkerHealthController, Phase
 * 4A-3): queue depth must never gate the same 200/503 decision a load
 * balancer probe acts on, since a deep-but-draining queue isn't itself an
 * outage. Exposes only aggregate counts per queue — never job ids,
 * organizationId, user ids, or job payloads; QueueRegistryService's own
 * state never holds any of that in the first place.
 *
 * On a Redis failure, returns the same predictable degraded shape rather
 * than letting the error surface as an unhandled 500 — mirrors
 * HealthController's own checkDatabase/checkRedis try/catch pattern.
 */
@Controller('health/queues')
@SkipThrottle()
export class QueueHealthController {
  constructor(private readonly queueRegistry: QueueRegistryService) {}

  @Public()
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
  ): Promise<QueueHealthResponse | QueueHealthErrorResponse> {
    try {
      const queues = await this.queueRegistry.getAllQueueCounts();
      return { queues };
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { error: 'Unable to retrieve queue counts', queues: [] };
    }
  }
}
