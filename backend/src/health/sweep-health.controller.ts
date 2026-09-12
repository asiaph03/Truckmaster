import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import {
  SweepHealthService,
  SweepHealthSnapshot,
  SweepScheduleDefinition,
} from '../common/sweep-health/sweep-health.service';
import {
  DAILY_SWEEP_CRON,
  JOB_NAMES,
  OPERATIONAL_SWEEP_INTERVAL_MS,
} from '../modules/background-jobs/services/background-jobs.constants';
import { BUSINESS_TIMEZONE } from '../common/timezone/business-timezone';

/** Fixed, developer-defined schedule metadata for all 6 sweeps — reuses the existing constants rather than duplicating literals. Order matches JOB_NAMES declaration order. */
const SWEEP_DEFINITIONS: SweepScheduleDefinition[] = [
  { name: JOB_NAMES.INVITATION_EXPIRATION_SWEEP, cadence: 'DAILY', schedule: DAILY_SWEEP_CRON, timezone: BUSINESS_TIMEZONE },
  { name: JOB_NAMES.QUOTE_EXPIRATION_SWEEP, cadence: 'DAILY', schedule: DAILY_SWEEP_CRON, timezone: BUSINESS_TIMEZONE },
  { name: JOB_NAMES.CARRIER_COMPLIANCE_EXPIRATION_SWEEP, cadence: 'DAILY', schedule: DAILY_SWEEP_CRON, timezone: BUSINESS_TIMEZONE },
  { name: JOB_NAMES.COMPLIANCE_EXPIRATION_NOTIFICATIONS, cadence: 'DAILY', schedule: DAILY_SWEEP_CRON, timezone: BUSINESS_TIMEZONE },
  {
    name: JOB_NAMES.CHECK_CALL_REMINDER_SWEEP,
    cadence: 'OPERATIONAL',
    schedule: `every ${OPERATIONAL_SWEEP_INTERVAL_MS / 60_000} minutes`,
    timezone: null,
  },
  {
    name: JOB_NAMES.LOAD_LATENESS_SWEEP,
    cadence: 'OPERATIONAL',
    schedule: `every ${OPERATIONAL_SWEEP_INTERVAL_MS / 60_000} minutes`,
    timezone: null,
  },
];

interface SweepHealthResponse {
  sweeps: SweepHealthSnapshot[];
}

/**
 * Monitoring Phase 4A-23D — read-only scheduled-sweep observability
 * diagnostic, separate from /health/workers by design (mirrors
 * QueueHealthController/WorkerHealthController, Phases 4A-3/4A-6):
 * `scheduled-jobs-worker` is one worker that owns six distinct business
 * sweeps, a different concept from worker process liveness, so this gets
 * its own endpoint rather than being nested awkwardly into the existing
 * flat worker-snapshot array.
 *
 * Always returns HTTP 200 — an overdue or unknown sweep is a degraded
 * business-processing signal, never a service-availability one, so this
 * must never gate the same 200/503 decision a load balancer probe acts
 * on (same reasoning already established for /health/workers and
 * /health/queues). SweepHealthService itself never throws — a Redis
 * failure or missing key both resolve to the explicit "unknown" shape
 * (null fields), never to an error response.
 *
 * Exposes only operational metadata: sweep name, its own fixed
 * schedule/timezone constants, and two timestamps — never organizationId,
 * job payload, or error content (this queue's job payload is always {}
 * anyway, per Phase 4A-17/4A-20).
 */
@Controller('health/sweeps')
@SkipThrottle()
export class SweepHealthController {
  constructor(private readonly sweepHealth: SweepHealthService) {}

  @Public()
  @Get()
  async list(): Promise<SweepHealthResponse> {
    const sweeps = await Promise.all(
      SWEEP_DEFINITIONS.map((definition) => this.sweepHealth.getSnapshot(definition)),
    );
    return { sweeps };
  }
}
