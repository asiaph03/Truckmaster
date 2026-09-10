import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBackupFreshness,
  decideAlertAction,
  evaluateBackupHealth,
  findNewestMatchingObject,
  isNewPipelineObjectKey,
  loadMonitorState,
  resolveFreshnessCheckConfig,
  runBackupFreshnessCheck,
  saveMonitorState,
  stateAfterFailedSend,
  type BackupHealthResult,
  type FreshnessCheckConfig,
  type MonitorState,
} from './backup-freshness-check';
import type { MinimalAwsClient, S3ObjectSummary } from './backup-aws-clients';

/**
 * Monitoring Phase 3 — tests the freshness checker entirely offline:
 * real S3/Postmark clients are never constructed (both are injected
 * stubs), and every timestamp is fixed, never Date.now(). Mirrors the
 * existing backup-database.spec.ts/backup-lock.spec.ts conventions
 * (fixture env vars, stub MinimalAwsClient, mkdtempSync for anything
 * that touches the real filesystem).
 */

const NOW = new Date('2026-09-10T13:00:00.000Z');

const VALID_ENV: NodeJS.ProcessEnv = {
  BACKUP_MONITOR_S3_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: 'fake-secret-value-not-real',
  BACKUP_MONITOR_S3_BUCKET: 'tms-db-backups-prod-2026',
  BACKUP_MONITOR_S3_REGION: 'us-east-1',
  BACKUP_MONITOR_POSTMARK_TOKEN: 'fake-postmark-token-not-real',
  BACKUP_MONITOR_ALERT_FROM: 'alerts@truckmasterdispatch.com',
  BACKUP_MONITOR_ALERT_TO: 'ops@truckmasterdispatch.com',
};

function makeConfig(overrides: Partial<FreshnessCheckConfig> = {}, stateFilePath: string): FreshnessCheckConfig {
  return {
    s3: {
      accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
      secretAccessKey: 'fake-secret-value-not-real',
      bucket: 'tms-db-backups-prod-2026',
      region: 'us-east-1',
      prefix: 'daily',
    },
    freshnessThresholdHours: 26,
    postmarkToken: 'fake-postmark-token-not-real',
    alertFrom: 'alerts@truckmasterdispatch.com',
    alertTo: 'ops@truckmasterdispatch.com',
    stateFilePath,
    ...overrides,
  };
}

function makeS3Client(objects: S3ObjectSummary[]): MinimalAwsClient {
  return {
    async send() {
      return { Contents: objects.map((o) => ({ Key: o.key, LastModified: o.lastModified })) };
    },
  };
}

function makeFailingS3Client(message: string): MinimalAwsClient {
  return {
    async send() {
      throw new Error(message);
    },
  };
}

describe('resolveFreshnessCheckConfig — isolated configuration', () => {
  it('resolves successfully with every required variable present', () => {
    const config = resolveFreshnessCheckConfig(VALID_ENV);
    expect(config.s3.bucket).toBe('tms-db-backups-prod-2026');
    expect(config.freshnessThresholdHours).toBe(26); // default
  });

  it('never falls back to RESTORE_VERIFY_*/BACKUP_*/application variables', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      RESTORE_VERIFY_S3_ACCESS_KEY_ID: 'other-identity-key',
      BACKUP_S3_ACCESS_KEY_ID: 'uploader-identity-key',
    };
    delete env.BACKUP_MONITOR_S3_ACCESS_KEY_ID;
    expect(() => resolveFreshnessCheckConfig(env)).toThrow(/BACKUP_MONITOR_S3_ACCESS_KEY_ID/);
  });

  it('lists every missing required variable, not just the first', () => {
    expect(() => resolveFreshnessCheckConfig({})).toThrow(
      /BACKUP_MONITOR_S3_ACCESS_KEY_ID.*BACKUP_MONITOR_S3_SECRET_ACCESS_KEY.*BACKUP_MONITOR_S3_BUCKET/s,
    );
  });

  it('accepts an explicit BACKUP_MONITOR_FRESHNESS_HOURS override', () => {
    const config = resolveFreshnessCheckConfig({ ...VALID_ENV, BACKUP_MONITOR_FRESHNESS_HOURS: '48' });
    expect(config.freshnessThresholdHours).toBe(48);
  });

  it('rejects a non-numeric or non-positive BACKUP_MONITOR_FRESHNESS_HOURS', () => {
    expect(() => resolveFreshnessCheckConfig({ ...VALID_ENV, BACKUP_MONITOR_FRESHNESS_HOURS: 'nope' })).toThrow(
      /BACKUP_MONITOR_FRESHNESS_HOURS/,
    );
    expect(() => resolveFreshnessCheckConfig({ ...VALID_ENV, BACKUP_MONITOR_FRESHNESS_HOURS: '0' })).toThrow(
      /BACKUP_MONITOR_FRESHNESS_HOURS/,
    );
  });
});

// ── A/B: pattern matching ────────────────────────────────────────────

describe('isNewPipelineObjectKey — new-pipeline vs. legacy pattern', () => {
  it('A. accepts the exact new-pipeline timestamped object pattern', () => {
    expect(isNewPipelineObjectKey('daily/tms_dev-20260909-180003Z.dump.enc', 'daily')).toBe(true);
  });

  it('B. rejects the legacy date-only object pattern', () => {
    expect(isNewPipelineObjectKey('daily/tms_dev-20260831.dump.enc', 'daily')).toBe(false);
  });

  it('rejects an object outside the given prefix', () => {
    expect(isNewPipelineObjectKey('weekly/tms_dev-20260909-180003Z.dump.enc', 'daily')).toBe(false);
  });

  it('rejects a nested "subfolder" object even if the filename matches', () => {
    expect(isNewPipelineObjectKey('daily/nested/tms_dev-20260909-180003Z.dump.enc', 'daily')).toBe(false);
  });

  it('rejects an unrelated database name', () => {
    expect(isNewPipelineObjectKey('daily/tms_other-20260909-180003Z.dump.enc', 'daily')).toBe(false);
  });
});

// ── C: newest-object selection ───────────────────────────────────────

describe('findNewestMatchingObject', () => {
  it('C. selects the newest matching object by LastModified, ignoring legacy and out-of-order entries', () => {
    const objects: S3ObjectSummary[] = [
      { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:04Z') },
      { key: 'daily/tms_dev-20260831.dump.enc', lastModified: new Date('2026-09-10T12:00:00Z') }, // legacy, newer mtime, must still be ignored
      { key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') },
      { key: 'daily/tms_dev-20260909-134205Z.dump.enc', lastModified: new Date('2026-09-09T21:42:08Z') },
    ];
    const newest = findNewestMatchingObject(objects, 'daily');
    expect(newest?.key).toBe('daily/tms_dev-20260909-180003Z.dump.enc');
  });

  it('returns undefined when nothing matches', () => {
    expect(findNewestMatchingObject([{ key: 'daily/tms_dev-20260831.dump.enc', lastModified: NOW }], 'daily')).toBeUndefined();
  });
});

// ── D/E/F: health evaluation ──────────────────────────────────────────

describe('evaluateBackupHealth', () => {
  it('D. a fresh matching object -> HEALTHY', () => {
    const result = evaluateBackupHealth({
      objects: [{ key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') }],
      prefix: 'daily',
      now: NOW, // ~11 hours after the object
      freshnessThresholdHours: 26,
    });
    expect(result.status).toBe('HEALTHY');
    expect(result.newestObject?.ageHours).toBeCloseTo(10.98, 1);
  });

  it('E. an object older than the threshold -> STALE', () => {
    const result = evaluateBackupHealth({
      objects: [{ key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') }],
      prefix: 'daily',
      now: NOW, // ~82 hours after the object
      freshnessThresholdHours: 26,
    });
    expect(result.status).toBe('STALE');
    expect(result.message).toMatch(/STALE|exceeding/i);
  });

  it('F. no matching object at all -> MISSING', () => {
    const result = evaluateBackupHealth({
      objects: [{ key: 'daily/tms_dev-20260831.dump.enc', lastModified: NOW }], // legacy-only bucket contents
      prefix: 'daily',
      now: NOW,
      freshnessThresholdHours: 26,
    });
    expect(result.status).toBe('MISSING');
  });

  it('an empty bucket listing -> MISSING (not UNKNOWN — the listing itself succeeded)', () => {
    const result = evaluateBackupHealth({ objects: [], prefix: 'daily', now: NOW, freshnessThresholdHours: 26 });
    expect(result.status).toBe('MISSING');
  });
});

// ── G/H: S3 failure -> UNKNOWN, treated as alertable ─────────────────

describe('checkBackupFreshness — S3 failure handling', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-backup-freshness-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('G. an S3 listing failure resolves to UNKNOWN rather than throwing', async () => {
    const config = makeConfig({}, join(dir, 'state.json'));
    const result = await checkBackupFreshness(
      config,
      { s3Client: makeFailingS3Client('connection refused') },
      NOW,
    );
    expect(result.status).toBe('UNKNOWN');
    expect(result.message).toMatch(/connection refused/);
  });

  it('H. UNKNOWN is treated as an alertable failure by decideAlertAction', () => {
    const unknown: BackupHealthResult = { status: 'UNKNOWN', message: 'could not list bucket' };
    const decision = decideAlertAction(unknown, undefined, NOW);
    expect(decision.shouldSendAlert).toBe(true);
    expect(decision.stateIfDelivered.lastState).toBe('ALERTED');
  });

  it('a successful listing correctly resolves to HEALTHY via the real evaluate path', async () => {
    const config = makeConfig({}, join(dir, 'state.json'));
    const s3Client = makeS3Client([
      { key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') },
    ]);
    const result = await checkBackupFreshness(config, { s3Client }, NOW);
    expect(result.status).toBe('HEALTHY');
  });
});

// ── I/J/K/L: alert/recovery state machine ────────────────────────────

describe('decideAlertAction — alert/recovery state machine', () => {
  const stale: BackupHealthResult = { status: 'STALE', message: 'too old' };
  const healthy: BackupHealthResult = { status: 'HEALTHY', message: 'fresh' };

  it('I. first failure (no prior state) triggers an alert', () => {
    const decision = decideAlertAction(stale, undefined, NOW);
    expect(decision.shouldSendAlert).toBe(true);
    expect(decision.shouldSendRecovery).toBe(false);
  });

  it('I. first failure (prior state OK) triggers an alert', () => {
    const previous: MonitorState = { lastState: 'OK', lastStatus: 'HEALTHY', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const decision = decideAlertAction(stale, previous, NOW);
    expect(decision.shouldSendAlert).toBe(true);
  });

  it('J. a repeated failure (prior state already ALERTED) does not trigger a duplicate alert', () => {
    const previous: MonitorState = { lastState: 'ALERTED', lastStatus: 'STALE', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const decision = decideAlertAction(stale, previous, NOW);
    expect(decision.shouldSendAlert).toBe(false);
    expect(decision.shouldSendRecovery).toBe(false);
    expect(decision.stateIfDelivered.lastState).toBe('ALERTED'); // stays alerted
  });

  it('K. recovery after a previously-alerted state triggers exactly one recovery notification', () => {
    const previous: MonitorState = { lastState: 'ALERTED', lastStatus: 'MISSING', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const decision = decideAlertAction(healthy, previous, NOW);
    expect(decision.shouldSendRecovery).toBe(true);
    expect(decision.shouldSendAlert).toBe(false);
    expect(decision.stateIfDelivered.lastState).toBe('OK');
  });

  it('L. continued healthy state (prior state already OK) does not repeatedly trigger recovery notifications', () => {
    const previous: MonitorState = { lastState: 'OK', lastStatus: 'HEALTHY', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const decision = decideAlertAction(healthy, previous, NOW);
    expect(decision.shouldSendRecovery).toBe(false);
    expect(decision.shouldSendAlert).toBe(false);
  });
});

describe('stateAfterFailedSend — preserves prior delivery state on a failed send', () => {
  const stale: BackupHealthResult = { status: 'STALE', message: 'too old' };
  const healthy: BackupHealthResult = { status: 'HEALTHY', message: 'fresh' };

  it('a failed alert send (no prior state) is preserved as "OK", never advanced to ALERTED', () => {
    const state = stateAfterFailedSend(undefined, stale, NOW);
    expect(state.lastState).toBe('OK');
  });

  it('a failed alert send (prior state OK) stays "OK", never advanced to ALERTED', () => {
    const previous: MonitorState = { lastState: 'OK', lastStatus: 'HEALTHY', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const state = stateAfterFailedSend(previous, stale, NOW);
    expect(state.lastState).toBe('OK');
  });

  it('a failed recovery send (prior state ALERTED) stays "ALERTED", never advanced to OK', () => {
    const previous: MonitorState = { lastState: 'ALERTED', lastStatus: 'STALE', lastCheckedAtUtc: '2026-09-09T04:00:00Z' };
    const state = stateAfterFailedSend(previous, healthy, NOW);
    expect(state.lastState).toBe('ALERTED');
  });

  it('still records the latest detected status/timestamp for diagnostics, independent of delivery state', () => {
    const state = stateAfterFailedSend(undefined, stale, NOW);
    expect(state.lastStatus).toBe('STALE');
    expect(state.lastCheckedAtUtc).toBe(NOW.toISOString());
  });
});

describe('loadMonitorState / saveMonitorState', () => {
  let dir: string;
  let stateFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-backup-freshness-state-test-'));
    stateFile = join(dir, 'nested', 'state.json'); // nested to prove the directory is created
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when the state file does not exist yet', () => {
    expect(loadMonitorState(stateFile)).toBeUndefined();
  });

  it('round-trips a saved state, creating intermediate directories', () => {
    const state: MonitorState = { lastState: 'ALERTED', lastStatus: 'STALE', lastCheckedAtUtc: NOW.toISOString() };
    saveMonitorState(stateFile, state);
    expect(loadMonitorState(stateFile)).toEqual(state);
  });

  it('treats corrupt state file content as "no prior state" rather than throwing', () => {
    saveMonitorState(stateFile, { lastState: 'OK', lastStatus: 'HEALTHY', lastCheckedAtUtc: NOW.toISOString() });
    require('node:fs').writeFileSync(stateFile, '{ not valid json');
    expect(loadMonitorState(stateFile)).toBeUndefined();
  });
});

// ── M: Postmark is always mocked, never the real service ─────────────

describe('runBackupFreshnessCheck — end-to-end orchestration with mocked S3 and Postmark', () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tms-backup-freshness-e2e-test-'));
    stateFile = join(dir, 'state.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFetchSpy(ok = true) {
    return jest.fn(async (_url: string, _init?: unknown) => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => (ok ? { ErrorCode: 0, Message: 'OK' } : { ErrorCode: 300, Message: 'Invalid token' }),
    }));
  }

  it('M. a healthy first run never calls Postmark at all', async () => {
    const fetchSpy = makeFetchSpy();
    const config = makeConfig({}, stateFile);
    const s3Client = makeS3Client([
      { key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') },
    ]);
    const exitCode = await runBackupFreshnessCheck(config, { s3Client, fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('M. a stale backup sends exactly one alert via the mocked Postmark client, never a real request', async () => {
    const fetchSpy = makeFetchSpy();
    const config = makeConfig({}, stateFile);
    const s3Client = makeS3Client([
      { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') },
    ]);
    const exitCode = await runBackupFreshnessCheck(config, { s3Client, fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    expect(exitCode).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.postmarkapp.com/email', expect.any(Object));
    // Never anything resembling a real external host beyond Postmark's own documented API endpoint.
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.postmarkapp.com/email');
  });

  it('a second consecutive stale run does not send a duplicate alert', async () => {
    const fetchSpy = makeFetchSpy();
    const staleObjects = [
      { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') },
    ];
    const config = makeConfig({}, stateFile);
    await runBackupFreshnessCheck(config, { s3Client: makeS3Client(staleObjects), fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    const secondCheckTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await runBackupFreshnessCheck(config, { s3Client: makeS3Client(staleObjects), fetchImpl: fetchSpy as unknown as typeof fetch }, secondCheckTime);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a recovery run after a prior alert sends exactly one recovery email', async () => {
    const fetchSpy = makeFetchSpy();
    const config = makeConfig({}, stateFile);
    const staleObjects = [
      { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') },
    ];
    const freshObjects = [
      { key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') },
    ];
    await runBackupFreshnessCheck(config, { s3Client: makeS3Client(staleObjects), fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    await runBackupFreshnessCheck(config, { s3Client: makeS3Client(freshObjects), fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // one alert, one recovery
  });

  it('a failed Postmark send is reported as a failed run (non-zero exit), never silently swallowed', async () => {
    const fetchSpy = makeFetchSpy(false);
    const config = makeConfig({}, stateFile);
    const s3Client = makeS3Client([
      { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') },
    ]);
    const exitCode = await runBackupFreshnessCheck(config, { s3Client, fetchImpl: fetchSpy as unknown as typeof fetch }, NOW);
    expect(exitCode).toBe(1);
  });

  // ── Regression sequence for the alert-state delivery bug ────────────
  // A failed send must never be recorded as if it had been delivered —
  // otherwise the very next unhealthy/healthy check would wrongly skip
  // the retry an ongoing incident needs.

  const staleObjects = [
    { key: 'daily/tms_dev-20260907-030302Z.dump.enc', lastModified: new Date('2026-09-07T03:03:02Z') },
  ];
  const freshObjects = [
    { key: 'daily/tms_dev-20260909-180003Z.dump.enc', lastModified: new Date('2026-09-10T02:00:06Z') },
  ];

  it('A. unhealthy + failed alert send -> non-zero exit, state NOT recorded as ALERTED', async () => {
    const fetchSpy = makeFetchSpy(false); // Postmark down
    const config = makeConfig({}, stateFile);
    const exitCode = await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(staleObjects), fetchImpl: fetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(exitCode).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the send WAS attempted
    expect(loadMonitorState(stateFile)?.lastState).toBe('OK'); // but never recorded as delivered
  });

  it('B. next run still unhealthy + Postmark now working -> alert is attempted again and succeeds', async () => {
    // Seed the "failed first attempt" state exactly as test A leaves it.
    const firstFetchSpy = makeFetchSpy(false);
    const config = makeConfig({}, stateFile);
    await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(staleObjects), fetchImpl: firstFetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(loadMonitorState(stateFile)?.lastState).toBe('OK');

    const secondFetchSpy = makeFetchSpy(true); // Postmark recovered
    const secondCheckTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const exitCode = await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(staleObjects), fetchImpl: secondFetchSpy as unknown as typeof fetch },
      secondCheckTime,
    );
    expect(exitCode).toBe(1); // still unhealthy
    expect(secondFetchSpy).toHaveBeenCalledTimes(1); // alert retried, NOT skipped as a "duplicate"
    expect(loadMonitorState(stateFile)?.lastState).toBe('ALERTED'); // now genuinely delivered
  });

  it('C. recovery + failed recovery send -> non-zero exit, state remains ALERTED', async () => {
    // First, a successfully delivered alert.
    const alertFetchSpy = makeFetchSpy(true);
    const config = makeConfig({}, stateFile);
    await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(staleObjects), fetchImpl: alertFetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(loadMonitorState(stateFile)?.lastState).toBe('ALERTED');

    // Now healthy, but Postmark fails for the recovery send.
    const recoveryFetchSpy = makeFetchSpy(false);
    const exitCode = await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(freshObjects), fetchImpl: recoveryFetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(exitCode).toBe(1);
    expect(recoveryFetchSpy).toHaveBeenCalledTimes(1); // the recovery send WAS attempted
    expect(loadMonitorState(stateFile)?.lastState).toBe('ALERTED'); // preserved, not falsely cleared
  });

  it('D. next healthy run + Postmark working -> recovery is attempted again and succeeds', async () => {
    // Seed the "successfully alerted, then failed recovery attempt" state exactly as test C leaves it.
    const alertFetchSpy = makeFetchSpy(true);
    const config = makeConfig({}, stateFile);
    await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(staleObjects), fetchImpl: alertFetchSpy as unknown as typeof fetch },
      NOW,
    );
    const failedRecoveryFetchSpy = makeFetchSpy(false);
    await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(freshObjects), fetchImpl: failedRecoveryFetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(loadMonitorState(stateFile)?.lastState).toBe('ALERTED');

    const secondRecoveryFetchSpy = makeFetchSpy(true); // Postmark recovered
    const exitCode = await runBackupFreshnessCheck(
      config,
      { s3Client: makeS3Client(freshObjects), fetchImpl: secondRecoveryFetchSpy as unknown as typeof fetch },
      NOW,
    );
    expect(exitCode).toBe(0); // healthy, and the pending recovery email was delivered
    expect(secondRecoveryFetchSpy).toHaveBeenCalledTimes(1); // recovery retried, NOT skipped
    expect(loadMonitorState(stateFile)?.lastState).toBe('OK'); // now genuinely transitioned out of ALERTED
  });
});
