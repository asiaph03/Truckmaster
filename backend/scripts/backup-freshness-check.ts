/**
 * Monitoring Phase 3 — independent freshness/failure alerting for the
 * Task #10 production backup pipeline (backup-production.ts). This
 * script never runs a backup, never touches PostgreSQL, and never
 * writes to S3 — it only lists the "daily/" prefix, decides whether the
 * newest *new-pipeline* object is fresh enough, and emails an alert (or
 * a one-time recovery notice) via Postmark when it isn't.
 *
 * Deliberately separate from every existing backup script and from the
 * legacy C:\TMSBackups\ pipeline: it runs on its own Windows Scheduled
 * Task, independent of whether the backup task itself ran, was
 * disabled, or was ever registered at all — a failure mode no alert
 * embedded *inside* the backup script could ever catch on its own.
 *
 * ── Why a strict key-pattern filter ──────────────────────────────────
 *
 * The legacy pipeline (C:\TMSBackups\run-backup.ps1) uploads into the
 * SAME bucket and the SAME "daily/" prefix, using a visually similar
 * but structurally different key shape (date-only, no time component:
 * "daily/tms_dev-YYYYMMDD.dump.enc"). Without a strict filter, a stale
 * or absent *new*-pipeline backup could be masked by an old legacy
 * object, or the legacy pipeline's own (currently failing) runs could
 * be mistaken for evidence the production backup of record is healthy.
 * NEW_PIPELINE_KEY_PATTERN matches only buildS3ObjectKey()'s exact
 * output shape (backup-database.ts) — full UTC timestamp with a
 * trailing "Z" — which the legacy pipeline's date-only key can never
 * produce.
 *
 * ── Environment variables ────────────────────────────────────────────
 *
 * Every BACKUP_MONITOR_* variable below is this script's own, isolated
 * configuration — never backend/.env, never BACKUP_* or RESTORE_VERIFY_*.
 * In production, BACKUP_MONITOR_S3_* is populated with the same
 * `tms-db-backup-restore` IAM identity's credentials already
 * provisioned for restore verification (reusing the identity, per this
 * task's approved architecture) — but this script resolves its own
 * copy of that config explicitly rather than reading RESTORE_VERIFY_*
 * directly, matching this repo's existing "no implicit fallback between
 * scripts" convention (see backup-restore-verify.ts's own doc comment).
 *
 * BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY (required)
 * BACKUP_MONITOR_S3_BUCKET / BACKUP_MONITOR_S3_REGION (required)
 *   The read-only listing identity and destination bucket.
 * BACKUP_MONITOR_S3_PREFIX (optional, defaults to "daily")
 * BACKUP_MONITOR_S3_ENDPOINT / BACKUP_MONITOR_S3_FORCE_PATH_STYLE (optional)
 *   Local S3-compatible test server override only.
 * BACKUP_MONITOR_FRESHNESS_HOURS (optional, defaults to 26)
 * BACKUP_MONITOR_POSTMARK_TOKEN (required)
 *   A Postmark server token — never logged, never included in any
 *   thrown error message.
 * BACKUP_MONITOR_ALERT_FROM / BACKUP_MONITOR_ALERT_TO (required)
 *   Sender/recipient for both the alert and the recovery email.
 * BACKUP_MONITOR_STATE_FILE (optional)
 *   Local JSON file tracking whether the previous check was alerted —
 *   defaults to backend/.local-backups/backup-freshness-state.json
 *   (gitignored) for local/manual runs. Production points this outside
 *   both the app repo and either backup pipeline's own directory (a
 *   fresh, purpose-specific path — a future ops task, not this file).
 *   Contains no secrets: only a status string and a timestamp.
 *
 * ── Exit code ─────────────────────────────────────────────────────────
 *
 * 0 only when the newest new-pipeline object is HEALTHY (fresh) and, if
 * an alert/recovery email was due, it was sent successfully. Non-zero
 * for STALE/MISSING/UNKNOWN — deliberately, so Task Scheduler's own run
 * history is a second, independent signal alongside the email, and so a
 * failed alert-send is never silently treated as a clean run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createS3Client, listObjects, type MinimalAwsClient, type S3ObjectSummary } from './backup-aws-clients';

export interface FreshnessCheckS3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface FreshnessCheckConfig {
  s3: FreshnessCheckS3Config;
  freshnessThresholdHours: number;
  postmarkToken: string;
  alertFrom: string;
  alertTo: string;
  stateFilePath: string;
}

export interface FreshnessCheckDependencies {
  s3Client?: MinimalAwsClient;
  fetchImpl?: typeof fetch;
}

const DEFAULT_S3_PREFIX = 'daily';
const DEFAULT_FRESHNESS_HOURS = 26;
const DEFAULT_STATE_FILE = join(__dirname, '..', '.local-backups', 'backup-freshness-state.json');

const REQUIRED_KEYS = [
  'BACKUP_MONITOR_S3_ACCESS_KEY_ID',
  'BACKUP_MONITOR_S3_SECRET_ACCESS_KEY',
  'BACKUP_MONITOR_S3_BUCKET',
  'BACKUP_MONITOR_S3_REGION',
  'BACKUP_MONITOR_POSTMARK_TOKEN',
  'BACKUP_MONITOR_ALERT_FROM',
  'BACKUP_MONITOR_ALERT_TO',
] as const;

/** Mirrors resolveBackupConfig()'s shape/philosophy: explicit-only, no fallback, fails before any S3/Postmark call. */
export function resolveFreshnessCheckConfig(source: NodeJS.ProcessEnv): FreshnessCheckConfig {
  const missing = REQUIRED_KEYS.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run backup freshness check: required env var(s) not set: ${missing.join(', ')}. ` +
        'This script never falls back to BACKUP_*/RESTORE_VERIFY_*/backend/.env — its configuration ' +
        'must always be supplied explicitly and separately.',
    );
  }

  const freshnessHoursRaw = source.BACKUP_MONITOR_FRESHNESS_HOURS?.trim();
  const freshnessThresholdHours = freshnessHoursRaw ? Number(freshnessHoursRaw) : DEFAULT_FRESHNESS_HOURS;
  if (!Number.isFinite(freshnessThresholdHours) || freshnessThresholdHours <= 0) {
    throw new Error(
      `Refusing to run backup freshness check: BACKUP_MONITOR_FRESHNESS_HOURS "${freshnessHoursRaw}" is not a positive number.`,
    );
  }

  return {
    s3: {
      accessKeyId: source.BACKUP_MONITOR_S3_ACCESS_KEY_ID!,
      secretAccessKey: source.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY!,
      bucket: source.BACKUP_MONITOR_S3_BUCKET!,
      region: source.BACKUP_MONITOR_S3_REGION!,
      prefix: source.BACKUP_MONITOR_S3_PREFIX?.trim() || DEFAULT_S3_PREFIX,
      endpoint: source.BACKUP_MONITOR_S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: source.BACKUP_MONITOR_S3_FORCE_PATH_STYLE === 'true' ? true : undefined,
    },
    freshnessThresholdHours,
    postmarkToken: source.BACKUP_MONITOR_POSTMARK_TOKEN!,
    alertFrom: source.BACKUP_MONITOR_ALERT_FROM!,
    alertTo: source.BACKUP_MONITOR_ALERT_TO!,
    stateFilePath: source.BACKUP_MONITOR_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
  };
}

// Matches exactly buildS3ObjectKey()'s output shape in backup-database.ts
// (full UTC timestamp, trailing "Z") — never the legacy pipeline's
// date-only "tms_dev-YYYYMMDD.dump.enc" shape. See this file's top
// comment for why this distinction matters.
const NEW_PIPELINE_FILENAME_PATTERN = /^tms_dev-\d{8}-\d{6}Z\.dump\.enc$/;

/**
 * True only for an object whose key is a direct child of `prefix`
 * (never a nested "subfolder") and whose filename matches the new
 * pipeline's exact naming shape. Exported for direct unit testing.
 */
export function isNewPipelineObjectKey(key: string, prefix: string): boolean {
  const expectedPrefix = `${prefix}/`;
  if (!key.startsWith(expectedPrefix)) {
    return false;
  }
  const filename = key.slice(expectedPrefix.length);
  if (filename.length === 0 || filename.includes('/')) {
    return false; // empty ("prefix/" itself) or nested under a subfolder — never a valid backup object
  }
  return NEW_PIPELINE_FILENAME_PATTERN.test(filename);
}

/** The most recently modified object matching the new pipeline's pattern, or undefined if none exist. Exported for direct unit testing. */
export function findNewestMatchingObject(
  objects: S3ObjectSummary[],
  prefix: string,
): S3ObjectSummary | undefined {
  const matching = objects.filter((entry) => isNewPipelineObjectKey(entry.key, prefix));
  if (matching.length === 0) {
    return undefined;
  }
  return matching.reduce((newest, entry) => (entry.lastModified > newest.lastModified ? entry : newest));
}

export type BackupHealthStatus = 'HEALTHY' | 'STALE' | 'MISSING' | 'UNKNOWN';

export interface BackupHealthResult {
  status: BackupHealthStatus;
  /** Human-readable, secret-free diagnostic — safe to log or email as-is. */
  message: string;
  newestObject?: { key: string; lastModified: Date; ageHours: number };
}

/**
 * Pure evaluation over an already-fetched object listing — never calls
 * S3 itself, so it's trivially testable with fixture data and a fixed
 * `now`. UNKNOWN is never produced here (a listing that succeeded, even
 * if empty, is always resolvable to HEALTHY/STALE/MISSING) — UNKNOWN is
 * reserved for checkBackupFreshness() below, when the S3 call itself
 * fails.
 */
export function evaluateBackupHealth(params: {
  objects: S3ObjectSummary[];
  prefix: string;
  now: Date;
  freshnessThresholdHours: number;
}): BackupHealthResult {
  const { objects, prefix, now, freshnessThresholdHours } = params;
  const newest = findNewestMatchingObject(objects, prefix);

  if (!newest) {
    return {
      status: 'MISSING',
      message: `No object matching the new production-pipeline pattern was found under "${prefix}/".`,
    };
  }

  const ageHours = (now.getTime() - newest.lastModified.getTime()) / (1000 * 60 * 60);
  const newestObject = { key: newest.key, lastModified: newest.lastModified, ageHours };

  if (ageHours > freshnessThresholdHours) {
    return {
      status: 'STALE',
      message:
        `Newest matching backup "${newest.key}" is ${ageHours.toFixed(1)}h old, exceeding the ` +
        `${freshnessThresholdHours}h freshness threshold.`,
      newestObject,
    };
  }

  return {
    status: 'HEALTHY',
    message:
      `Newest matching backup "${newest.key}" is ${ageHours.toFixed(1)}h old ` +
      `(within the ${freshnessThresholdHours}h freshness threshold).`,
    newestObject,
  };
}

/**
 * Lists the bucket and evaluates freshness. Any failure to list S3 at
 * all (bad credentials, network failure, bucket unreachable) resolves
 * to UNKNOWN rather than propagating — per this task's explicit
 * requirement, UNKNOWN is always treated as an alertable failure by the
 * caller (decideAlertAction below), never silently skipped.
 */
export async function checkBackupFreshness(
  config: FreshnessCheckConfig,
  deps: FreshnessCheckDependencies,
  now: Date = new Date(),
): Promise<BackupHealthResult> {
  let objects: S3ObjectSummary[];
  try {
    const s3Client =
      deps.s3Client ??
      createS3Client({
        region: config.s3.region,
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
        endpoint: config.s3.endpoint,
        forcePathStyle: config.s3.forcePathStyle,
      });
    objects = await listObjects(s3Client, config.s3.bucket, `${config.s3.prefix}/`);
  } catch (error) {
    return {
      status: 'UNKNOWN',
      message: `Could not list s3://${config.s3.bucket}/${config.s3.prefix}/: ${(error as Error).message}`,
    };
  }

  return evaluateBackupHealth({
    objects,
    prefix: config.s3.prefix,
    now,
    freshnessThresholdHours: config.freshnessThresholdHours,
  });
}

// ── Alert state ──────────────────────────────────────────────────────

const UNHEALTHY_STATUSES: readonly BackupHealthStatus[] = ['STALE', 'MISSING', 'UNKNOWN'];

export interface MonitorState {
  lastState: 'OK' | 'ALERTED';
  lastStatus: BackupHealthStatus;
  lastCheckedAtUtc: string;
}

export interface AlertDecision {
  shouldSendAlert: boolean;
  shouldSendRecovery: boolean;
  /**
   * The state to persist ONLY if no send is required, or if a required
   * send actually succeeds — i.e. this represents successful
   * notification delivery, not merely that an unhealthy/healthy
   * condition was detected. A failed send must never use this value;
   * see stateAfterFailedSend() below, which the caller
   * (runBackupFreshnessCheck) is required to use instead on that path.
   */
  stateIfDelivered: MonitorState;
}

/**
 * Pure state-transition function — no I/O, no clock reads (`now` is
 * always supplied by the caller). An alert fires only on the first
 * unhealthy check since the last *successfully delivered* alert (never
 * once per unhealthy day thereafter); a recovery email fires only once,
 * on the first healthy check after a previously-*delivered* alert.
 * `previousState` being undefined (first-ever run, or an
 * unreadable/missing state file) is treated identically to a prior
 * "OK" state — the safe direction to fail in, since the worst case is
 * one redundant alert on an unhealthy first run, never a suppressed
 * one.
 *
 * `stateIfDelivered` describes what SHOULD be persisted assuming the
 * decided send (if any) succeeds. It must not be persisted blindly —
 * see stateAfterFailedSend() for the failure path, which is what makes
 * "ALERTED"/"OK" represent confirmed notification delivery rather than
 * mere detection (the bug this pair of functions fixes: a state
 * flipped to ALERTED without the email actually having been sent would
 * permanently suppress the retry an ongoing incident needs).
 */
export function decideAlertAction(
  currentResult: BackupHealthResult,
  previousState: MonitorState | undefined,
  now: Date,
): AlertDecision {
  const isUnhealthy = UNHEALTHY_STATUSES.includes(currentResult.status);
  const wasAlerted = previousState?.lastState === 'ALERTED';

  if (isUnhealthy) {
    return {
      shouldSendAlert: !wasAlerted,
      shouldSendRecovery: false,
      stateIfDelivered: { lastState: 'ALERTED', lastStatus: currentResult.status, lastCheckedAtUtc: now.toISOString() },
    };
  }

  return {
    shouldSendAlert: false,
    shouldSendRecovery: wasAlerted,
    stateIfDelivered: { lastState: 'OK', lastStatus: currentResult.status, lastCheckedAtUtc: now.toISOString() },
  };
}

/**
 * The state to persist when a required send (alert or recovery) FAILS.
 * Deliberately keeps `lastState` exactly as it was before this run —
 * never advances to "ALERTED" for a failed alert send (which would
 * falsely claim delivery and permanently suppress the retry the next
 * unhealthy check must attempt), and never advances to "OK" for a
 * failed recovery send (which would drop the one-time recovery email
 * instead of retrying it on the next healthy check). `lastStatus`/
 * `lastCheckedAtUtc` still update, purely for diagnostic freshness —
 * only `lastState` (the notification-delivery field) is preserved.
 */
export function stateAfterFailedSend(
  previousState: MonitorState | undefined,
  currentResult: BackupHealthResult,
  now: Date,
): MonitorState {
  return {
    lastState: previousState?.lastState ?? 'OK',
    lastStatus: currentResult.status,
    lastCheckedAtUtc: now.toISOString(),
  };
}

/** Returns undefined on any read/parse failure (no file yet, corrupt content) — the caller treats that as "no prior state." */
export function loadMonitorState(stateFilePath: string): MonitorState | undefined {
  try {
    const raw = readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MonitorState>;
    if (parsed.lastState !== 'OK' && parsed.lastState !== 'ALERTED') {
      return undefined;
    }
    return parsed as MonitorState;
  } catch {
    return undefined;
  }
}

export function saveMonitorState(stateFilePath: string, state: MonitorState): void {
  const dir = dirname(stateFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

// ── Postmark alerting ────────────────────────────────────────────────

interface PostmarkResponse {
  ErrorCode: number;
  Message: string;
}

/**
 * Same request shape as PostmarkEmailSender (backend/src/common/email),
 * reimplemented standalone here rather than imported: this script must
 * run outside the Nest DI container (a plain scheduled-task process),
 * and never reads the application's own Postmark config
 * (ConfigService/backend/.env) — see this file's top comment. The
 * error thrown on failure includes only Postmark's own response
 * message/HTTP status, never `postmarkToken` itself.
 */
export async function sendPostmarkEmail(params: {
  postmarkToken: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const response = await params.fetchImpl('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': params.postmarkToken,
    },
    body: JSON.stringify({
      From: params.from,
      To: params.to,
      Subject: params.subject,
      TextBody: params.body,
    }),
  });

  const result = (await response.json().catch(() => undefined)) as PostmarkResponse | undefined;
  if (!response.ok || !result || result.ErrorCode !== 0) {
    const detail = result?.Message ?? `HTTP ${response.status}`;
    throw new Error(`Postmark send failed: ${detail}`);
  }
}

function buildAlertEmail(result: BackupHealthResult): { subject: string; body: string } {
  return {
    subject: `[TMS] Production backup alert — ${result.status}`,
    body:
      `The TMS production backup freshness check reported ${result.status}.\n\n${result.message}\n\n` +
      'This does not necessarily mean data was lost — check C:\\TMSBackupRuntime\\ logs and the ' +
      's3://tms-db-backups-prod-2026/daily/ prefix directly to confirm.',
  };
}

function buildRecoveryEmail(result: BackupHealthResult): { subject: string; body: string } {
  return {
    subject: '[TMS] Production backup recovered',
    body: `The TMS production backup freshness check is HEALTHY again.\n\n${result.message}`,
  };
}

/**
 * Runs the full check -> decide -> alert -> persist-state sequence and
 * returns a process exit code — never calls process.exit() itself. See
 * this file's top-of-file doc comment for the exact exit-code contract.
 */
export async function runBackupFreshnessCheck(
  config: FreshnessCheckConfig,
  deps: FreshnessCheckDependencies = {},
  now: Date = new Date(),
): Promise<number> {
  console.log('[backup-freshness-check] Checking production backup freshness...');
  console.log(
    `[backup-freshness-check] Target: s3://${config.s3.bucket}/${config.s3.prefix}/ ` +
      `(threshold=${config.freshnessThresholdHours}h)`,
  );

  const result = await checkBackupFreshness(config, deps, now);
  console.log(`[backup-freshness-check] Result: ${result.status} — ${result.message}`);

  const previousState = loadMonitorState(config.stateFilePath);
  const decision = decideAlertAction(result, previousState, now);
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    if (decision.shouldSendAlert) {
      const { subject, body } = buildAlertEmail(result);
      console.log('[backup-freshness-check] Sending alert email...');
      await sendPostmarkEmail({
        postmarkToken: config.postmarkToken,
        from: config.alertFrom,
        to: config.alertTo,
        subject,
        body,
        fetchImpl,
      });
      console.log('[backup-freshness-check] Alert email sent.');
    } else if (decision.shouldSendRecovery) {
      const { subject, body } = buildRecoveryEmail(result);
      console.log('[backup-freshness-check] Sending recovery email...');
      await sendPostmarkEmail({
        postmarkToken: config.postmarkToken,
        from: config.alertFrom,
        to: config.alertTo,
        subject,
        body,
        fetchImpl,
      });
      console.log('[backup-freshness-check] Recovery email sent.');
    } else {
      console.log('[backup-freshness-check] No email needed (no state change).');
    }
  } catch (error) {
    console.error(`[backup-freshness-check] Failed to send email: ${(error as Error).message}`);
    // Deliberately NOT decision.stateIfDelivered — that would falsely
    // record the alert/recovery as delivered when it never was. Persist
    // stateAfterFailedSend() instead, which preserves the previous
    // delivery state (lastState) so the next check retries the send:
    // an unhealthy check retries the alert, a healthy check retries the
    // recovery notification. The run as a whole is still reported as
    // FAILED (see the return value below).
    saveMonitorState(config.stateFilePath, stateAfterFailedSend(previousState, result, now));
    return 1;
  }

  saveMonitorState(config.stateFilePath, decision.stateIfDelivered);
  return result.status === 'HEALTHY' ? 0 : 1;
}

/* istanbul ignore next -- thin CLI entrypoint, exercised via the exported functions instead */
function main(): void {
  let config: FreshnessCheckConfig;
  try {
    config = resolveFreshnessCheckConfig(process.env);
  } catch (error) {
    console.error(`[backup-freshness-check] Configuration error: ${(error as Error).message}`);
    process.exit(1);
  }
  runBackupFreshnessCheck(config)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[backup-freshness-check] Unexpected fatal error: ${(error as Error).message}`);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}
