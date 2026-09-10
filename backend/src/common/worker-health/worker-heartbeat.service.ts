import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Monitoring Phase 4A-3 — worker liveness tracking, in-memory only.
 *
 * Chosen over a Redis- or DB-backed heartbeat specifically because this app
 * is a single-process deployment: in-memory state is the only option that
 * keeps reporting a meaningful answer during a Redis outage (worker
 * connections and this tracking are entirely independent) instead of going
 * blank exactly when visibility matters most. See the Phase 4A-3 preflight
 * report for the full design comparison against Redis-backed/DB-backed
 * alternatives.
 *
 * Each of the 8 BullMQ workers registers itself once (onModuleInit, after
 * its Worker instance exists) and reports two kinds of signal:
 *  - job/queue events ('active', 'completed', 'failed') via recordActivity,
 *    proving the worker is genuinely consuming from its queue;
 *  - a periodic self-check (this service's own internal tick, polling each
 *    registered worker's own `isRunning()`), which is what keeps a
 *    genuinely idle worker (no jobs at all) reporting HEALTHY rather than
 *    going stale — job traffic and liveness are deliberately independent
 *    signals so an idle queue is never mistaken for a dead worker.
 * A BullMQ Worker-level 'error' event (connection/infra-level, distinct
 * from a single job's 'failed') is reported via recordError instead —
 * a stronger, more immediate signal than staleness.
 */

export type WorkerHeartbeatStatus = 'STARTING' | 'HEALTHY' | 'STALE' | 'ERROR';

export interface WorkerHeartbeatSnapshot {
  name: string;
  status: WorkerHeartbeatStatus;
  lastSeenAt: string | null;
  lastEventType: string | null;
}

interface WorkerHeartbeatEntry {
  lastSeenAt: number | null;
  lastEventType: string | null;
  errored: boolean;
  isRunning: () => boolean;
}

/** How often each registered worker's own isRunning() is polled. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * A worker with no activity (event or tick) for longer than this is STALE.
 * Kept well above HEARTBEAT_INTERVAL_MS (3x) so a single missed/delayed
 * tick is never mistaken for a genuine problem.
 */
export const STALE_THRESHOLD_MS = 3 * 60_000;

@Injectable()
export class WorkerHeartbeatService implements OnModuleDestroy {
  private readonly entries = new Map<string, WorkerHeartbeatEntry>();
  private tickHandle?: NodeJS.Timeout;

  /** Called once per worker from its own onModuleInit(), after the BullMQ Worker instance exists. */
  register(name: string, isRunning: () => boolean): void {
    this.entries.set(name, { lastSeenAt: null, lastEventType: null, errored: false, isRunning });
    this.ensureTicking();
  }

  /**
   * Called from a worker's onModuleDestroy(). Stops polling and removes it
   * from reported snapshots — a cleanly-stopped worker isn't a liveness
   * problem to surface, it just intentionally isn't part of the running
   * app anymore (mirrors the worker's own .close()/.quit() teardown).
   */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  /** A signal that the worker is alive and consuming: 'active', 'completed', 'failed', or the internal 'tick'. Clears any prior error — renewed activity is itself evidence of recovery. */
  recordActivity(name: string, eventType: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.lastSeenAt = Date.now();
    entry.lastEventType = eventType;
    entry.errored = false;
  }

  /** BullMQ's own Worker-level 'error' event. */
  recordError(name: string, eventType: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.lastSeenAt = Date.now();
    entry.lastEventType = eventType;
    entry.errored = true;
  }

  getSnapshot(name: string): WorkerHeartbeatSnapshot | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return { name, ...this.deriveStatus(entry) };
  }

  getAllSnapshots(): WorkerHeartbeatSnapshot[] {
    return [...this.entries.entries()]
      .map(([name, entry]) => ({ name, ...this.deriveStatus(entry) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  onModuleDestroy(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  private deriveStatus(
    entry: WorkerHeartbeatEntry,
  ): Pick<WorkerHeartbeatSnapshot, 'status' | 'lastSeenAt' | 'lastEventType'> {
    if (entry.lastSeenAt === null) {
      return { status: 'STARTING', lastSeenAt: null, lastEventType: null };
    }
    if (entry.errored) {
      return {
        status: 'ERROR',
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
        lastEventType: entry.lastEventType,
      };
    }
    const age = Date.now() - entry.lastSeenAt;
    const status: WorkerHeartbeatStatus = age > STALE_THRESHOLD_MS ? 'STALE' : 'HEALTHY';
    return {
      status,
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
      lastEventType: entry.lastEventType,
    };
  }

  private ensureTicking(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
    this.tickHandle.unref?.();
  }

  private tick(): void {
    for (const [name, entry] of this.entries) {
      if (entry.isRunning()) {
        this.recordActivity(name, 'tick');
      }
    }
  }
}
