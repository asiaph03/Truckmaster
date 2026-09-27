import { JobsOptions } from 'bullmq';

export const LOCATION_RESOLUTION_QUEUE = 'LOCATION_RESOLUTION_QUEUE';
export const LOCATION_RESOLUTION_QUEUE_NAME = 'resolve-location';

/**
 * Dashboard Map Phase 2 — one worker/queue resolves BOTH a Load's
 * current (Check Call) location and its Stops (pickup/intermediate/
 * delivery), never a CheckCall-specific mechanism. `entityType`
 * discriminates which table the resolved result is written back to;
 * `jobId` (set to `${entityType}:${entityId}` at enqueue time) gives
 * BullMQ's own de-dup — a second enqueue for the same entity while one
 * is still queued/active is silently ignored.
 */
export type LocationResolutionEntityType = 'CHECK_CALL' | 'STOP';

export interface LocationResolutionJobData {
  entityType: LocationResolutionEntityType;
  entityId: string;
  organizationId: string;
  city: string;
  state: string;
  /**
   * CHECK_CALL only — the Load.currentLocationUpdatedAt value written by
   * logCheckCall()'s own synchronous update, captured at enqueue time.
   * The worker only writes Load.currentLocationLat/Lng back if this
   * still exactly matches the Load's current value — if a later Check
   * Call has since been logged (bumping currentLocationUpdatedAt again),
   * this guard fails closed and the stale job's coordinates are
   * correctly never applied. Mirrors the ordering semantic
   * logCheckCall() already uses for city/state (creation order, not
   * occurredAt order) — not a new policy, just extending the existing
   * one to lat/lng.
   */
  asOfLoadUpdatedAt?: string;
}

/**
 * Same retention/backoff shape as every other queue in this codebase
 * (see MALWARE_SCAN_JOB_OPTIONS/EMAIL_JOB_OPTIONS) — attempts=3 covers
 * transient Redis/DB hiccups only; there is no external geocoder call
 * in this phase to retry against.
 */
export const LOCATION_RESOLUTION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 604800 },
  removeOnFail: { count: 2000, age: 2592000 },
};
