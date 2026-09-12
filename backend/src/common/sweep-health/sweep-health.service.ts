import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Monitoring Phase 4A-23D — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/** Approved Phase 4A-23C/D grace windows — explicit policy thresholds, not derived from execution-duration data. Never revisited without a separate approval. */
const DAILY_GRACE_MS = 27 * 60 * 60 * 1000;
const OPERATIONAL_GRACE_MS = 45 * 60 * 1000;

export type SweepCadence = 'DAILY' | 'OPERATIONAL';

/** Fixed, developer-defined metadata about one sweep's own schedule — never derived from job data. */
export interface SweepScheduleDefinition {
  name: string;
  cadence: SweepCadence;
  schedule: string;
  timezone: string | null;
}

export interface SweepHealthSnapshot {
  sweepName: string;
  schedule: string;
  timezone: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** null = unknown (no state recorded yet, or Redis unreachable) — never conflated with true/false. */
  lastAttemptSucceeded: boolean | null;
  /** null = unknown — per the approved design, missing state is unknown, never treated as overdue. */
  overdue: boolean | null;
}

function redisKey(sweepName: string): string {
  return `sweep-health:${sweepName}`;
}

/**
 * Monitoring Phase 4A-23D — the smallest durable state needed to answer,
 * per sweep: when was it last attempted, when did it last succeed, did the
 * latest attempt fail, and is it overdue. Deliberately Redis-backed (not
 * in-memory, unlike WorkerHeartbeatService) because the condition this is
 * meant to catch — a missed/late scheduled run — is defined by the
 * process's own absence, so the state must survive exactly the restart
 * that in-memory state would not (see the Phase 4A-23 design audit).
 *
 * Holds only a fixed sweep name (a developer-defined constant, never
 * derived from job data) plus two epoch-millisecond timestamps. Never
 * reads job.data, organizationId, or any error content — this queue's job
 * payload is always {} anyway (Phase 4A-17/4A-20).
 *
 * Every write and read is best-effort: a Redis failure here must never
 * affect the sweep's own business outcome, and must never surface as an
 * unhandled error to a health-endpoint caller — both paths degrade to an
 * explicit "unknown" result instead.
 */
@Injectable()
export class SweepHealthService {
  private readonly logger = new Logger(SweepHealthService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Called from ScheduledJobsWorker's 'completed' handler only. Best-effort — never throws. */
  async recordSuccess(sweepName: string, at: number): Promise<void> {
    try {
      await this.redis.hset(redisKey(sweepName), { lastAttemptAt: at, lastSuccessAt: at });
    } catch (error) {
      this.logger.warn(
        `event=sweep_health_write_failed sweep=${sweepName} outcome=success errorType=${errorTypeOf(error)}`,
      );
    }
  }

  /** Called from ScheduledJobsWorker's 'failed' handler only. Best-effort — never throws. lastSuccessAt is intentionally left untouched. */
  async recordFailure(sweepName: string, at: number): Promise<void> {
    try {
      await this.redis.hset(redisKey(sweepName), { lastAttemptAt: at });
    } catch (error) {
      this.logger.warn(
        `event=sweep_health_write_failed sweep=${sweepName} outcome=failure errorType=${errorTypeOf(error)}`,
      );
    }
  }

  /**
   * Read-only, best-effort. Never throws — a Redis failure or missing key
   * both resolve to the explicit "unknown" shape (lastAttemptSucceeded and
   * overdue both null), never to a thrown error and never to a false
   * "overdue: true" or "overdue: false".
   */
  async getSnapshot(
    definition: SweepScheduleDefinition,
    now: number = Date.now(),
  ): Promise<SweepHealthSnapshot> {
    const base = {
      sweepName: definition.name,
      schedule: definition.schedule,
      timezone: definition.timezone,
    };
    const unknown: SweepHealthSnapshot = {
      ...base,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastAttemptSucceeded: null,
      overdue: null,
    };

    let raw: Record<string, string>;
    try {
      raw = await this.redis.hgetall(redisKey(definition.name));
    } catch (error) {
      this.logger.warn(
        `event=sweep_health_read_failed sweep=${definition.name} errorType=${errorTypeOf(error)}`,
      );
      return unknown;
    }

    if (!raw.lastAttemptAt && !raw.lastSuccessAt) {
      return unknown;
    }

    const lastAttemptAt = raw.lastAttemptAt ? Number(raw.lastAttemptAt) : null;
    const lastSuccessAt = raw.lastSuccessAt ? Number(raw.lastSuccessAt) : null;
    const lastAttemptSucceeded =
      lastAttemptAt !== null && lastSuccessAt !== null ? lastAttemptAt === lastSuccessAt : null;
    const graceMs = definition.cadence === 'DAILY' ? DAILY_GRACE_MS : OPERATIONAL_GRACE_MS;
    const overdue = lastSuccessAt !== null ? now - lastSuccessAt > graceMs : null;

    return {
      ...base,
      lastAttemptAt: lastAttemptAt !== null ? new Date(lastAttemptAt).toISOString() : null,
      lastSuccessAt: lastSuccessAt !== null ? new Date(lastSuccessAt).toISOString() : null,
      lastAttemptSucceeded,
      overdue,
    };
  }
}
