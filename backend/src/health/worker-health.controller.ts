import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import {
  WorkerHeartbeatService,
  WorkerHeartbeatSnapshot,
} from '../common/worker-health/worker-heartbeat.service';

interface WorkerHealthResponse {
  workers: WorkerHeartbeatSnapshot[];
}

/**
 * Monitoring Phase 4A-3 — read-only worker liveness diagnostic, separate
 * from /health by design (see HealthController and the Phase 4A-3 preflight
 * report): worker liveness must never gate the same 200/503 decision
 * UptimeRobot and any future load-balancer probe act on, since a queue
 * being legitimately idle is not a failure. This endpoint exposes only
 * operational metadata — worker name, derived status, last-seen timestamp,
 * and the literal event-type string that last updated it (e.g. "active",
 * "tick") — never job data, organizationId, or any business/customer
 * information; WorkerHeartbeatService's own state never holds any of that
 * in the first place.
 */
@Controller('health/workers')
@SkipThrottle()
export class WorkerHealthController {
  constructor(private readonly heartbeat: WorkerHeartbeatService) {}

  @Public()
  @Get()
  list(): WorkerHealthResponse {
    return { workers: this.heartbeat.getAllSnapshots() };
  }
}
