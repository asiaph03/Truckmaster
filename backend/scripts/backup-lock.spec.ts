import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBackupLock } from './backup-lock';

/**
 * Task #10C.2.1 — proves the dependency-free backup lock in complete
 * isolation: real filesystem operations against a throwaway temp
 * directory, but no pg_dump, no AWS, no real concurrent processes.
 * `process.kill` is mocked where a specific liveness answer needs to be
 * deterministic, rather than depending on picking an actually-unused
 * real PID (which could theoretically, if vanishingly unlikely, exist).
 */

describe('acquireBackupLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-backup-lock-test-'));
    lockPath = join(dir, '.backup.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('the first process acquires the lock', () => {
    const lock = acquireBackupLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
  });

  it('a second concurrent attempt is rejected with a clear error while the lock is held', () => {
    const lock = acquireBackupLock(lockPath);
    expect(() => acquireBackupLock(lockPath)).toThrow(/already running/i);
    lock.release();
  });

  it('releases the lock on success — the lock file is removed', () => {
    const lock = acquireBackupLock(lockPath);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a lock can be acquired again immediately after being released', () => {
    acquireBackupLock(lockPath).release();
    const secondLock = acquireBackupLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    secondLock.release();
  });

  it('releasing twice is a safe no-op', () => {
    const lock = acquireBackupLock(lockPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it('reclaims a stale lock whose recorded PID is no longer running (crash recovery)', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 424242, hostname: hostname(), startedAtUtc: new Date(0).toISOString() }),
    );
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });

    try {
      const lock = acquireBackupLock(lockPath); // should succeed by reclaiming the dead lock
      expect(existsSync(lockPath)).toBe(true);
      lock.release();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does NOT reclaim a lock whose recorded PID is still alive', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 424242, hostname: hostname(), startedAtUtc: new Date().toISOString() }),
    );
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as const);

    try {
      expect(() => acquireBackupLock(lockPath)).toThrow(/already running/i);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('treats an unparseable lock file as stale and reclaims it', () => {
    writeFileSync(lockPath, 'not valid json');
    const lock = acquireBackupLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
  });

  it('never reclaims a lock recorded for a different hostname, regardless of PID liveness', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 424242, hostname: 'some-other-machine', startedAtUtc: new Date(0).toISOString() }),
    );
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });

    try {
      expect(() => acquireBackupLock(lockPath)).toThrow(/already running/i);
    } finally {
      killSpy.mockRestore();
    }
  });
});
