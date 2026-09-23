import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupStalePlaintextDumps } from './backup-database';

/**
 * Task #10C.2.1 — proves the stale-plaintext sweep is narrowly scoped:
 * it only ever removes files matching this script's own plaintext-dump
 * naming pattern, only once they're old enough that a currently-running
 * backup could never be mistaken for one, and never touches an
 * encrypted ".dump.enc" file or anything unrelated. Pure filesystem
 * operations against a throwaway temp directory — no pg_dump, no AWS.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('cleanupStalePlaintextDumps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-backup-cleanup-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFile(name: string, ageMs: number): string {
    const filePath = join(dir, name);
    writeFileSync(filePath, 'fixture content');
    const past = new Date(Date.now() - ageMs);
    utimesSync(filePath, past, past);
    return filePath;
  }

  it('removes a stale plaintext dump matching the naming pattern', () => {
    const stale = makeFile('tms_local_test_2026-09-01T00-00-00-000Z.dump', ONE_HOUR_MS * 2);
    cleanupStalePlaintextDumps(dir);
    expect(existsSync(stale)).toBe(false);
  });

  it('preserves a recent plaintext dump — could belong to a currently-running backup', () => {
    const recent = makeFile('tms_local_test_2026-09-06T05-34-08-406Z.dump', 5000); // 5 seconds old
    cleanupStalePlaintextDumps(dir);
    expect(existsSync(recent)).toBe(true);
  });

  it('never removes an encrypted .dump.enc file, no matter how old', () => {
    const encrypted = makeFile('tms_local_test_2026-09-01T00-00-00-000Z.dump.enc', ONE_HOUR_MS * 10);
    cleanupStalePlaintextDumps(dir);
    expect(existsSync(encrypted)).toBe(true);
  });

  it('never removes unrelated files, no matter how old', () => {
    const unrelated = makeFile('notes.txt', ONE_HOUR_MS * 10);
    const lockFile = makeFile('.backup.lock', ONE_HOUR_MS * 10);
    cleanupStalePlaintextDumps(dir);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
  });

  it('handles a nonexistent output directory without throwing', () => {
    expect(() => cleanupStalePlaintextDumps(join(dir, 'does-not-exist'))).not.toThrow();
  });

  it('a mix of files results in only the stale plaintext dump being removed', () => {
    const stalePlaintext = makeFile('tms_dev_2026-08-01T00-00-00-000Z.dump', ONE_HOUR_MS * 24);
    const recentPlaintext = makeFile('tms_dev_2026-09-06T05-00-00-000Z.dump', 1000);
    const encrypted = makeFile('tms_dev_2026-08-01T00-00-00-000Z.dump.enc', ONE_HOUR_MS * 24);
    const unrelated = makeFile('README.md', ONE_HOUR_MS * 24);

    cleanupStalePlaintextDumps(dir);

    expect(existsSync(stalePlaintext)).toBe(false);
    expect(existsSync(recentPlaintext)).toBe(true);
    expect(existsSync(encrypted)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
