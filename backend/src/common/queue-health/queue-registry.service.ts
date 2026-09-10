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

  /** Read-only — getJobCounts() never mutates queue state. Queried in parallel; a name collision (there should never be one) would simply overwrite the earlier registration. */
  async getAllQueueCounts(): Promise<QueueCountsSnapshot[]> {
    const entries = [...this.queues.entries()];
    const snapshots = await Promise.all(
      entries.map(async ([name, queue]) => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
        };
      }),
    );
    return snapshots.sort((a, b) => a.name.localeCompare(b.name));
  }
}
