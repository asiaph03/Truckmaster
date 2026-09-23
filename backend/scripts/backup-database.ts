/**
 * Task #10A/#10C.2 — PostgreSQL backup script. Shells out to `pg_dump`
 * in custom format (`-Fc`), validates the result with `pg_restore
 * --list`, then encrypts it (AES-256-GCM, via an AWS KMS-generated data
 * key) and uploads the encrypted artifact to S3. No scheduling, no
 * alerting — those remain separate, later tasks (#10C/#10D). See the
 * repo's Task #10 audit trail for the full phased plan.
 *
 * ── Environment variables ──────────────────────────────────────────
 *
 * BACKUP_DATABASE_URL (required, no default, no fallback)
 *   A full Postgres connection URL. This script NEVER reads
 *   DATABASE_URL or any other value from backend/.env — the caller must
 *   always be explicit about exactly which database is being backed up.
 *
 * BACKUP_OUTPUT_DIR (optional)
 *   Directory the local plaintext/encrypted temp files are written
 *   into before upload. Created if missing. Defaults to
 *   backend/.local-backups/ (gitignored) — a convenience default for
 *   local/manual runs, not a production path.
 *
 * PG_DUMP_PATH / PG_RESTORE_PATH (optional)
 *   Full path to the pg_dump / pg_restore executable. Defaults to
 *   "pg_dump" / "pg_restore" (relies on PATH). On this Windows machine
 *   neither is on PATH by default — the real binaries live at
 *   "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" (and pg_restore.exe
 *   alongside it).
 *
 * BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY (required)
 * BACKUP_S3_BUCKET / BACKUP_S3_REGION (required)
 * BACKUP_KMS_KEY_ID (required)
 *   The backup-only S3/KMS destination and credential — deliberately
 *   separate from the application's own S3_* variables (which belong to
 *   the document-storage bucket/credential). This script never falls
 *   back to those, and these five variables must never be added to
 *   backend/.env (see Task #10C.2's own safety requirements) — they are
 *   supplied only to this script's own process environment.
 *
 * BACKUP_S3_ENDPOINT / BACKUP_S3_FORCE_PATH_STYLE (optional)
 *   Only for pointing at a local S3-compatible test server (e.g.
 *   s3rver, see backup-database.local-test.ts) instead of real AWS.
 *   Left unset, the AWS SDK resolves the real regional S3 endpoint.
 *
 * BACKUP_S3_PREFIX (optional, Task #10C.3.1)
 *   The S3 key prefix backups are written under. Defaults to "daily" —
 *   production behavior is unchanged unless this is explicitly set.
 *   A controlled, non-production integration test (real AWS, but a
 *   tms_local_test-sourced dump) sets this to "test" to keep its
 *   artifact isolated from real daily backups in the same bucket — see
 *   buildS3ObjectKey()/normalizeS3Prefix() below for the exact naming
 *   and validation rules. This setting only ever changes the key
 *   prefix; it cannot redirect the bucket, region, or endpoint.
 *

 * ── Local test usage ────────────────────────────────────────────────
 *
 *   npm run backup:database:test-local
 *
 * (see scripts/backup-database.local-test.ts — guaranteed-safe target
 * against tms_local_test, with a local ephemeral S3 server and a stub
 * KMS client; never touches real AWS or production).
 *
 * Direct invocation (used by a future Task Scheduler wiring):
 *
 *   set BACKUP_DATABASE_URL=postgresql://...
 *   set BACKUP_OUTPUT_DIR=C:\path\to\backups
 *   set PG_DUMP_PATH=C:\Program Files\PostgreSQL\18\bin\pg_dump.exe
 *   set PG_RESTORE_PATH=C:\Program Files\PostgreSQL\18\bin\pg_restore.exe
 *   set BACKUP_S3_ACCESS_KEY_ID=...
 *   set BACKUP_S3_SECRET_ACCESS_KEY=...
 *   set BACKUP_S3_BUCKET=tms-db-backups-prod-2026
 *   set BACKUP_S3_REGION=us-east-1
 *   set BACKUP_KMS_KEY_ID=arn:aws:kms:us-east-1:955075461399:key/2fa9912f-1f3b-4fbb-8db0-c1660b0b68db
 *   npm run backup:database
 *
 * ── Execution order / failure behavior ──────────────────────────────
 *
 * 1. pg_dump (custom format) -> local plaintext temp file.
 * 2. Non-zero exit / missing / empty file -> FAILURE, cleanup, done.
 * 3. pg_restore --list integrity check -> FAILURE on any problem.
 * 4. KMS GenerateDataKey -> on failure, delete the plaintext dump,
 *    FAILURE. Nothing has touched S3 yet.
 * 5. Encrypt locally (AES-256-GCM) -> on failure, delete the plaintext
 *    dump, FAILURE. The plaintext data key is zeroed immediately after
 *    this step, whether it succeeded or not.
 * 6. Write the encrypted envelope to a local temp file, THEN delete the
 *    plaintext dump — no plaintext dump remains on disk once encryption
 *    has succeeded, regardless of what happens next.
 * 7. Upload the encrypted file to S3. On failure, the local encrypted
 *    file is deliberately NOT deleted — it is the only remaining copy
 *    of this backup, and deleting it on top of a failed upload would
 *    mean losing the backup entirely. FAILURE is still reported (exit
 *    non-zero) and the previous successful S3 backup is never touched —
 *    this script has no delete/overwrite code path at all.
 * 8. Only after the upload is confirmed does the local encrypted file
 *    get removed, and the process reports SUCCESS (exit 0).
 *
 * There is no code path that logs SUCCESS without every one of these
 * checks having passed — a caller (human or Task Scheduler) can trust
 * the exit code alone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createKmsClient,
  createS3Client,
  generateDataKey,
  uploadObject,
  type MinimalAwsClient,
} from './backup-aws-clients';
import { encryptToEnvelope } from './backup-envelope';
import { acquireBackupLock, type LockHandle } from './backup-lock';

export type { MinimalAwsClient } from './backup-aws-clients';

export interface BackupS3Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  /**
   * Normalized S3 key prefix (no leading/trailing slash) — "daily" in
   * production, "test" for a controlled integration test. Required
   * (not optional) so every construction site — resolveBackupConfig(),
   * the local-test harness, tests — states its intent explicitly rather
   * than relying on a default buried somewhere else.
   */
  prefix: string;
  /** Local/test S3-compatible endpoint override (e.g. s3rver). Unset in production. */
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface BackupConfig {
  databaseUrl: string;
  outputDir: string;
  pgDumpPath: string;
  pgRestorePath: string;
  kmsKeyId: string;
  s3: BackupS3Config;
}

/** Reported to `BackupDependencies.onUploadSuccess` — see its own doc comment. */
export interface BackupUploadSuccessInfo {
  s3Key: string;
  bucket: string;
}

/** Injectable AWS clients — tests pass stubs here; real runs let these default. */
export interface BackupDependencies {
  kmsClient?: MinimalAwsClient;
  s3Client?: MinimalAwsClient;
  /**
   * Task #10C.6C — invoked exactly once, only after the encrypted backup
   * has been confirmed uploaded to S3, with the exact key/bucket that
   * were used. Lets a caller (the production backup+verify orchestration
   * in backup-production.ts) hand that exact object off to restore
   * verification without re-deriving the key from a second
   * Date.now()/new Date() call, which could theoretically drift from the
   * one actually used for the upload. Never called on any failure path.
   */
  onUploadSuccess?: (info: BackupUploadSuccessInfo) => void;
}

const DEFAULT_OUTPUT_DIR = join(__dirname, '..', '.local-backups');
const DEFAULT_PG_DUMP_PATH = 'pg_dump';
const DEFAULT_PG_RESTORE_PATH = 'pg_restore';
const BACKUP_LOCK_FILE_NAME = '.backup.lock';

// Backups complete in seconds to low minutes even for a large database —
// an hour is a wide safety margin that a currently-running backup could
// never be mistaken for stale, while still reclaiming genuinely
// orphaned plaintext debris from a crashed prior run promptly.
const STALE_PLAINTEXT_MAX_AGE_MS = 60 * 60 * 1000;

// Matches exactly the format produced by timestampedFileName() below
// (e.g. "tms_dev_2026-09-06T05-34-08-406Z.dump") — narrowly scoped so
// cleanup can never touch an encrypted ".dump.enc" file, a lock file,
// or any unrelated file that happens to share this directory.
const PLAINTEXT_DUMP_PATTERN = /^.+_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.dump$/;

const REQUIRED_BACKUP_DESTINATION_KEYS = [
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_REGION',
  'BACKUP_KMS_KEY_ID',
] as const;

export const DEFAULT_S3_PREFIX = 'daily';
const S3_PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Normalizes and validates BACKUP_S3_PREFIX. Unset -> the production
 * default ("daily"), never an error. Explicitly set but empty (or only
 * whitespace/slashes) after trimming -> a clear config error, not a
 * silent fallback, since that looks like a mistake rather than "leave
 * it at the default." Every "/"-separated segment is restricted to
 * letters/digits/"-"/"_" — this single character-class restriction is
 * what rules out path traversal ("..", which contains only dots — never
 * a permitted character), backslashes, whitespace, and anything
 * URL-or-bucket-override-shaped ("s3://...", "http://...", "C:\\..."
 * all contain ":" or "\\", neither of which is permitted). This setting
 * only ever produces a key prefix — it has no way to change the bucket,
 * region, or endpoint a backup is written to.
 */
export function normalizeS3Prefix(rawPrefix: string | undefined): string {
  if (rawPrefix === undefined) {
    return DEFAULT_S3_PREFIX;
  }

  const stripped = rawPrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (stripped.length === 0) {
    throw new Error(
      'Refusing to back up: BACKUP_S3_PREFIX was set but is empty (or only whitespace/slashes) after ' +
        `normalization. Omit it entirely to use the default "${DEFAULT_S3_PREFIX}" prefix, or set it to a real value.`,
    );
  }

  const segments = stripped.split('/');
  const invalidSegment = segments.find((segment) => !S3_PREFIX_SEGMENT_PATTERN.test(segment));
  if (invalidSegment !== undefined) {
    throw new Error(
      `Refusing to back up: BACKUP_S3_PREFIX "${rawPrefix}" is invalid — each "/"-separated segment must ` +
        'contain only letters, digits, "-", and "_" (no "..", no whitespace, no ":", no "\\", no empty segments).',
    );
  }

  return segments.join('/');
}

/**
 * Pure, side-effect-free config resolution — mirrors e2e-env-guard.ts's
 * own shape (a plain function over NodeJS.ProcessEnv) so it stays
 * trivially testable without touching a real environment variable.
 * Fails before anything (pg_dump included) runs if the backup
 * destination isn't fully configured — there is no point producing a
 * dump this process cannot finish protecting.
 */
export function resolveBackupConfig(source: NodeJS.ProcessEnv): BackupConfig {
  const databaseUrl = source.BACKUP_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Refusing to back up: BACKUP_DATABASE_URL is not set. This script never falls back to ' +
        'DATABASE_URL or any other value from backend/.env — the caller must always be ' +
        'explicit about which database is being backed up.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing to back up: BACKUP_DATABASE_URL is not a valid connection URL.');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('Refusing to back up: BACKUP_DATABASE_URL has no database name in its path.');
  }

  const missing = REQUIRED_BACKUP_DESTINATION_KEYS.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to back up: required backup-destination env var(s) not set: ${missing.join(', ')}. ` +
        "This script never falls back to the application's own S3_* variables or credentials — " +
        'the backup upload identity must always be configured explicitly and separately.',
    );
  }

  return {
    databaseUrl,
    outputDir: source.BACKUP_OUTPUT_DIR?.trim() || DEFAULT_OUTPUT_DIR,
    pgDumpPath: source.PG_DUMP_PATH?.trim() || DEFAULT_PG_DUMP_PATH,
    pgRestorePath: source.PG_RESTORE_PATH?.trim() || DEFAULT_PG_RESTORE_PATH,
    kmsKeyId: source.BACKUP_KMS_KEY_ID!,
    s3: {
      accessKeyId: source.BACKUP_S3_ACCESS_KEY_ID!,
      secretAccessKey: source.BACKUP_S3_SECRET_ACCESS_KEY!,
      bucket: source.BACKUP_S3_BUCKET!,
      region: source.BACKUP_S3_REGION!,
      prefix: normalizeS3Prefix(source.BACKUP_S3_PREFIX),
      endpoint: source.BACKUP_S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: source.BACKUP_S3_FORCE_PATH_STYLE === 'true' ? true : undefined,
    },
  };
}

/** Non-sensitive connection details only — host/port/dbname/user, never the password. */
function describeTarget(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  return `host=${url.hostname} port=${url.port || '5432'} dbname=${dbName} user=${url.username || '(unspecified)'}`;
}

/**
 * Exported (Task #10C.6C) so the production orchestration
 * (backup-production.ts) can resolve the actual target database name
 * the same way this file does internally, then pass it to
 * assertProductionDatabaseTarget() before runBackup() is invoked —
 * rather than re-parsing BACKUP_DATABASE_URL itself or trusting the raw
 * URL string.
 */
export function databaseNameFromUrl(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '') || 'database';
}

function timestampedFileName(databaseUrl: string): string {
  const dbName = databaseNameFromUrl(databaseUrl);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe, sortable
  return `${dbName}_${stamp}.dump`;
}

/**
 * Builds the S3 object key for an encrypted backup: `<prefix>/<db>-
 * YYYYMMDD-HHMMSSZ.dump.enc`, always in UTC (never the host's local
 * timezone, which was never confirmed for the production Windows
 * machine — see Task #10C.1's preflight). A full timestamp, not just a
 * date, makes a same-day collision structurally impossible without any
 * other uniqueness mechanism. `prefix` must already be normalized (see
 * normalizeS3Prefix()) — this function does not re-validate it.
 * Exported for direct unit testing.
 */
export function buildS3ObjectKey(dbName: string, prefix: string, now: Date = new Date()): string {
  const iso = now.toISOString(); // e.g. "2026-09-06T20:00:00.000Z"
  const datePart = iso.slice(0, 10).replace(/-/g, ''); // "20260906"
  const timePart = iso.slice(11, 19).replace(/:/g, ''); // "200000"
  return `${prefix}/${dbName}-${datePart}-${timePart}Z.dump.enc`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Sweeps `outputDir` for plaintext dump files left behind by a
 * previous, interrupted run (e.g. the process was killed between a
 * successful pg_dump and successful encryption). Narrowly scoped in
 * three independent ways: the filename must match this script's own
 * plaintext-dump naming pattern exactly (never touches ".dump.enc",
 * the lock file, or an unrelated file); it must be an actual file, not
 * a directory; and it must be older than STALE_PLAINTEXT_MAX_AGE_MS,
 * so a file the currently-running backup just created moments ago can
 * never be mistaken for stale debris. Never logs a filename, only a
 * count, and never fails the calling backup over a cleanup problem.
 */
export function cleanupStalePlaintextDumps(outputDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(outputDir);
  } catch {
    return; // directory doesn't exist yet, or unreadable — nothing to clean
  }

  const now = Date.now();
  let removedCount = 0;
  for (const entry of entries) {
    if (!PLAINTEXT_DUMP_PATTERN.test(entry)) {
      continue;
    }
    const fullPath = join(outputDir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    if (now - stats.mtimeMs < STALE_PLAINTEXT_MAX_AGE_MS) {
      continue; // too recent to safely assume it's from a dead run
    }
    try {
      unlinkSync(fullPath);
      removedCount += 1;
    } catch {
      // Best-effort — don't fail the current backup over cleanup of an unrelated stale file.
    }
  }

  if (removedCount > 0) {
    console.log(
      `[backup] Cleaned up ${removedCount} stale plaintext dump file(s) left by a previous interrupted run.`,
    );
  }
}

function cleanupPartialOutput(outputPath: string): void {
  if (existsSync(outputPath)) {
    try {
      unlinkSync(outputPath);
      console.log(`[backup] Removed local file: ${outputPath}`);
    } catch (cleanupError) {
      console.error(
        `[backup] Warning: failed to remove local file ${outputPath}: ${(cleanupError as Error).message}`,
      );
    }
  }
}

/**
 * Connection env vars for the pg_dump/pg_restore child process — never
 * passed as CLI args. PGPASSWORD is only set when BACKUP_DATABASE_URL
 * actually embeds one — when it doesn't, libpq falls through to its own
 * standard `.pgpass` / (on Windows) `%APPDATA%\postgresql\pgpass.conf`
 * lookup automatically. Setting PGPASSWORD to an empty string would NOT
 * achieve the same effect — libpq treats an explicitly-set (even empty)
 * PGPASSWORD as "use this," not as "fall through to pgpass" — so the
 * key must be entirely absent from the child env, not merely empty.
 */
export function pgConnectionEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGUSER: decodeURIComponent(url.username),
  };
  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
  }
  return env;
}

/**
 * Encrypts an already-validated plaintext dump and uploads it to S3.
 * Split out from runBackup() so it can be unit-tested directly against
 * a fixture plaintext file — no real pg_dump invocation or database
 * needed — with injected KMS/S3 stubs (see backup-database.spec.ts).
 * Never calls process.exit(); returns the same exit-code convention as
 * runBackup(). See this file's top-of-file doc comment for the exact
 * failure semantics at each step.
 */
export async function encryptAndUploadDump(params: {
  plaintextPath: string;
  dbName: string;
  kmsKeyId: string;
  s3: BackupS3Config;
  deps?: BackupDependencies;
}): Promise<number> {
  const { plaintextPath, dbName, kmsKeyId, s3, deps = {} } = params;
  const encryptedPath = `${plaintextPath}.enc`;

  // Defense in depth: encryptAndUploadDump is exported and independently
  // callable (see backup-database.spec.ts), not only reachable via
  // runBackup()'s own zero-byte check after pg_dump. A future caller
  // that skips that check must still never encrypt-and-upload an empty
  // "backup" — reject it here, before KMS or S3 are ever touched.
  let plaintextStats: ReturnType<typeof statSync>;
  try {
    plaintextStats = statSync(plaintextPath);
  } catch (error) {
    console.error(`[backup] Cannot read plaintext dump at ${plaintextPath}: ${(error as Error).message} — FAILURE.`);
    return 1;
  }
  if (plaintextStats.size === 0) {
    console.error('[backup] Refusing to encrypt an empty (zero-byte) plaintext dump — FAILURE.');
    cleanupPartialOutput(plaintextPath);
    return 1;
  }

  const kmsClient = deps.kmsClient ?? createKmsClient(s3.region, s3.accessKeyId, s3.secretAccessKey);
  let plaintextDataKey: Buffer;
  let encryptedDataKey: Buffer;
  console.log('[backup] Requesting data key from AWS KMS...');
  try {
    const dataKey = await generateDataKey(kmsClient, kmsKeyId);
    plaintextDataKey = dataKey.plaintextKey;
    encryptedDataKey = dataKey.encryptedKey;
  } catch (error) {
    console.error(`[backup] KMS GenerateDataKey failed: ${(error as Error).message} — FAILURE.`);
    cleanupPartialOutput(plaintextPath);
    return 1;
  }

  let envelope: Buffer;
  try {
    console.log('[backup] Encrypting backup (AES-256-GCM)...');
    const plaintext = readFileSync(plaintextPath);
    envelope = encryptToEnvelope({
      plaintext,
      plaintextDataKey,
      encryptedDataKey,
      kmsKeyId,
      sourceDatabase: dbName,
    });
  } catch (error) {
    console.error(`[backup] Encryption failed: ${(error as Error).message} — FAILURE.`);
    cleanupPartialOutput(plaintextPath);
    return 1;
  } finally {
    // The plaintext data key is never needed again after this point —
    // zero it defensively regardless of success or failure above.
    plaintextDataKey.fill(0);
  }

  try {
    writeFileSync(encryptedPath, envelope);
  } catch (error) {
    console.error(`[backup] Failed to write encrypted backup file: ${(error as Error).message} — FAILURE.`);
    cleanupPartialOutput(plaintextPath);
    cleanupPartialOutput(encryptedPath);
    return 1;
  }

  // No plaintext dump should remain on disk once encryption has
  // succeeded, regardless of whether the upload below succeeds.
  cleanupPartialOutput(plaintextPath);
  console.log(`[backup] Encrypted backup written locally: ${encryptedPath} (${formatBytes(envelope.length)})`);

  const s3Client =
    deps.s3Client ??
    createS3Client({
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle,
    });
  const s3Key = buildS3ObjectKey(dbName, s3.prefix);
  console.log(`[backup] Uploading to s3://${s3.bucket}/${s3Key} ...`);
  try {
    await uploadObject(s3Client, s3.bucket, s3Key, envelope);
  } catch (error) {
    console.error(
      `[backup] S3 upload failed: ${(error as Error).message} — FAILURE. The encrypted backup was ` +
        `NOT deleted and remains available locally for a retry: ${encryptedPath}`,
    );
    return 1;
  }

  // Only after the upload is confirmed does the local encrypted copy get removed.
  cleanupPartialOutput(encryptedPath);
  console.log(`[backup] SUCCESS — uploaded s3://${s3.bucket}/${s3Key} (${formatBytes(envelope.length)})`);
  deps.onUploadSuccess?.({ s3Key, bucket: s3.bucket });
  return 0;
}

/**
 * Runs the backup end to end (dump -> validate -> encrypt -> upload)
 * and returns a process exit code — never calls process.exit() itself,
 * so callers (the test harness, unit tests, this file's own main())
 * decide what to do with the result. `deps` lets callers inject
 * KMS/S3 clients (or stubs) instead of the real AWS-backed ones this
 * function constructs by default.
 */
export async function runBackup(config: BackupConfig, deps: BackupDependencies = {}): Promise<number> {
  console.log('[backup] Starting PostgreSQL backup...');
  console.log(`[backup] Target: ${describeTarget(config.databaseUrl)}`);
  console.log(`[backup] Output directory: ${config.outputDir}`);
  console.log(
    `[backup] S3 destination: s3://${config.s3.bucket}/${config.s3.prefix}/ (region=${config.s3.region})`,
  );

  // Directory preparation gets its own try/catch so a failure here
  // (permissions, disk full, invalid path) produces a controlled
  // FAILURE + nonzero exit rather than an unhandled rejection — nothing
  // past this point (including the lock) has happened yet.
  try {
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
      console.log(`[backup] Created output directory: ${config.outputDir}`);
    }
  } catch (error) {
    console.error(`[backup] Failed to prepare output directory: ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  // ---- Acquire the concurrency lock BEFORE pg_dump starts ----
  let lock: LockHandle;
  try {
    lock = acquireBackupLock(join(config.outputDir, BACKUP_LOCK_FILE_NAME));
  } catch (error) {
    console.error(`[backup] ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  try {
    // Sweep any plaintext debris left by a previous interrupted run
    // now that we hold the exclusive lock — safe to do before this
    // run's own pg_dump starts.
    cleanupStalePlaintextDumps(config.outputDir);

    const dbName = databaseNameFromUrl(config.databaseUrl);
    const outputPath = join(config.outputDir, timestampedFileName(config.databaseUrl));
    const childEnv = pgConnectionEnv(config.databaseUrl);

    // ---- pg_dump ----
    console.log(`[backup] Running pg_dump -> ${outputPath}`);
    const dumpResult = spawnSync(
      config.pgDumpPath,
      ['--format=custom', '--file', outputPath, '--verbose'],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (dumpResult.error) {
      console.error(`[backup] Failed to launch pg_dump: ${dumpResult.error.message} — FAILURE.`);
      cleanupPartialOutput(outputPath);
      return 1;
    }
    if (dumpResult.stderr?.length) {
      console.log(`[backup] pg_dump output:\n${dumpResult.stderr.toString().trim()}`);
    }
    if (dumpResult.status !== 0) {
      console.error(`[backup] pg_dump exited with code ${dumpResult.status} — FAILURE.`);
      cleanupPartialOutput(outputPath);
      return dumpResult.status ?? 1;
    }
    if (!existsSync(outputPath)) {
      console.error('[backup] pg_dump reported success but no output file was created — FAILURE.');
      return 1;
    }
    const dumpStats = statSync(outputPath);
    if (dumpStats.size === 0) {
      console.error('[backup] Backup file is empty — FAILURE.');
      cleanupPartialOutput(outputPath);
      return 1;
    }

    // ---- pg_restore --list integrity check ----
    console.log('[backup] Verifying backup integrity with pg_restore --list...');
    const listResult = spawnSync(config.pgRestorePath, ['--list', outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (listResult.error || listResult.status !== 0) {
      console.error(
        `[backup] Integrity check failed — pg_restore --list could not read the backup file. ` +
          `${listResult.error ? listResult.error.message : `exit code ${listResult.status}`} — FAILURE.`,
      );
      cleanupPartialOutput(outputPath);
      return 1;
    }
    console.log(`[backup] pg_dump validated — ${formatBytes(dumpStats.size)}`);

    return await encryptAndUploadDump({
      plaintextPath: outputPath,
      dbName,
      kmsKeyId: config.kmsKeyId,
      s3: config.s3,
      deps,
    });
  } catch (error) {
    // Catch-all so any unexpected failure inside the locked section
    // still produces a controlled FAILURE and releases the lock below,
    // rather than an unhandled rejection. Never include more than the
    // error's own message — same convention as every other failure
    // path in this file.
    console.error(`[backup] Unexpected error: ${(error as Error).message} — FAILURE.`);
    return 1;
  } finally {
    lock.release();
  }
}

/* istanbul ignore next -- thin CLI entrypoint, exercised via the exported functions instead */
function main(): void {
  let config: BackupConfig;
  try {
    config = resolveBackupConfig(process.env);
  } catch (error) {
    console.error(`[backup] Configuration error: ${(error as Error).message}`);
    process.exit(1);
  }
  runBackup(config)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[backup] Unexpected fatal error: ${(error as Error).message} — FAILURE.`);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}
