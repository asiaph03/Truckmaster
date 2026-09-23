/**
 * Task #10C.2.1 — a dependency-free, Windows-compatible advisory lock so
 * only one backup process runs at a time. Uses atomic exclusive file
 * creation (the 'wx' flag — O_CREAT | O_EXCL under the hood, which Node
 * implements correctly on Windows as well as POSIX) rather than an
 * in-memory flag, so it works across separate process invocations (e.g.
 * an overlapping Task Scheduler run), not just within one process.
 *
 * Stale-lock recovery uses PID liveness (process.kill(pid, 0)), never a
 * blind time-based delete — a lock is only ever reclaimed once the PID
 * recorded in it demonstrably no longer exists on this same host.
 *
 * This is a best-effort advisory lock, not a true OS-level exclusive
 * lock — Windows has no exact equivalent to POSIX flock() without
 * native bindings, which this repo deliberately avoids adding for
 * something this narrow (see the repo's own "no large dependency just
 * for locking" constraint). The exclusive-create + PID-liveness
 * combination closes the two failure modes that actually matter here:
 * two backups running at once, and a crashed run's lock blocking every
 * future backup forever.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

export interface LockHandle {
  release(): void;
}

interface LockFileContents {
  pid: number;
  hostname: string;
  startedAtUtc: string;
}

function isLockStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return true; // gone or unreadable — safe to treat as reclaimable
  }

  let data: Partial<LockFileContents>;
  try {
    data = JSON.parse(raw);
  } catch {
    return true; // corrupt/malformed content can't belong to a real active run
  }

  if (typeof data.pid !== 'number') {
    return true;
  }
  if (typeof data.hostname === 'string' && data.hostname !== hostname()) {
    // A different machine's lock (e.g. a shared network path) — never
    // assume stale based on a PID that isn't even ours to check.
    return false;
  }

  try {
    process.kill(data.pid, 0); // throws if the process cannot be signaled
    return false; // process exists — genuinely still running
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'; // no such process => stale
  }
}

/**
 * Acquires the backup lock at `lockPath`, reclaiming it first if it's
 * stale (owning PID no longer alive on this host). Throws a clear error
 * if the lock is genuinely held by another running process.
 */
export function acquireBackupLock(lockPath: string): LockHandle {
  const content = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    startedAtUtc: new Date().toISOString(),
  } satisfies LockFileContents);

  const tryCreate = (): void => {
    writeFileSync(lockPath, content, { flag: 'wx' }); // atomic create-or-fail
  };

  try {
    tryCreate();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    if (!isLockStale(lockPath)) {
      throw new Error(
        `Refusing to start: another backup process is already running (lock file: ${lockPath}).`,
      );
    }
    // Reclaim: remove the dead process's lock and retry once.
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have removed/replaced it already — fall through and retry create.
    }
    try {
      tryCreate();
    } catch {
      throw new Error(
        `Refusing to start: another backup process is already running (lock file: ${lockPath}).`,
      );
    }
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        if (existsSync(lockPath)) {
          const raw = readFileSync(lockPath, 'utf8');
          const data = JSON.parse(raw) as Partial<LockFileContents>;
          // Only remove it if it's still the lock this handle created —
          // defensive against an extremely unlikely reclaim race.
          if (data.pid === process.pid) {
            unlinkSync(lockPath);
          }
        }
      } catch {
        // Lock already gone or unreadable — nothing more to do.
      }
    },
  };
}
