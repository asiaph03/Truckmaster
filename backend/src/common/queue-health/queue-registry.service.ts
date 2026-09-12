import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * Monitoring Phase 4A-6 — read-only job-count snapshot for one queue.
 * Deliberately excludes `paused` (no code anywhere calls `.pause()` on any
 * queue, so the field would always read a constant, zero-information
 * value) and anything from job data (id, payload, organizationId) — this
 * mirrors WorkerHeartbeatSnapshot's own "operational metadata only" shape.
 */
export interface QueueCountsSnapshot {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  /** Age in ms of the oldest currently waiting job (Job.timestamp), or null if none is waiting. */
  oldestWaitingAgeMs: number | null;
  /** Age in ms of the oldest currently active job (Job.processedOn), or null if none is active or it has no processedOn yet. */
  oldestActiveAgeMs: number | null;
}

/** Never negative — a clock skew or in-flight timestamp update could otherwise produce a negative age. */
function ageMs(timestamp: number | null | undefined, now: number): number | null {
  if (timestamp === null || timestamp === undefined) return null;
  const age = now - timestamp;
  return age < 0 ? 0 : age;
}

/**
 * Monitoring Phase 4A-6 — in-memory registry of every BullMQ Queue producer
 * in the app, mirroring WorkerHeartbeatService's exact registration pattern
 * (Phase 4A-3): each queue-owning module factory registers its Queue
 * instance here as a side effect of construction, rather than this service
 * (or a controller) depending on the Queue DI tokens directly — 6 of the 8
 * tokens aren't exported from their owning modules today, so direct
 * injection here would require adding `exports:` to those modules and
 * importing every feature module into HealthModule, a much heavier coupling
 * than this read-only diagnostic needs.
 *
 * Holds only Queue references (BullMQ's own producer handles) — no job
 * data is ever stored here; counts are always fetched live via
 * `getJobCounts()`.
 */
@Injectable()
export class QueueRegistryService {
  private readonly queues = new Map<string, Queue>();

  /** Called once from a queue-owning module's Queue provider factory, right after construction. */
  register(name: string, queue: Queue): void {
    this.queues.set(name, queue);
  }

  /**
   * Read-only — getJobCounts()/getWaiting()/getActive() never mutate queue
   * state. Queried in parallel; a name collision (there should never be
   * one) would simply overwrite the earlier registration.
   *
   * Monitoring Phase 4A-25 — getWaiting(0, 0)/getActive(0, 0) each fetch
   * exactly one job (BullMQ's own bounded LRANGE per job type — confirmed
   * by reading the installed bullmq source; both hardcode ascending order
   * internally, so index 0 is always the oldest job), never the full
   * waiting/active list. Only Job.timestamp/Job.processedOn (plain
   * numbers) are read — never job.data/payload/organizationId.
   */
  async getAllQueueCounts(): Promise<QueueCountsSnapshot[]> {
    const entries = [...this.queues.entries()];
    const now = Date.now();
    const snapshots = await Promise.all(
      entries.map(async ([name, queue]) => {
        const [counts, oldestWaiting, oldestActive] = await Promise.all([
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
          queue.getWaiting(0, 0),
          queue.getActive(0, 0),
        ]);
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          oldestWaitingAgeMs: ageMs(oldestWaiting[0]?.timestamp, now),
          oldestActiveAgeMs: ageMs(oldestActive[0]?.processedOn, now),
        };
      }),
    );
    return snapshots.sort((a, b) => a.name.localeCompare(b.name));
  }
}
