/**
 * Task #10C.4 — automated restore verification: downloads an encrypted
 * backup object, decrypts it (KMS Decrypt via the RESTORER identity —
 * never the uploader's GenerateDataKey credential), restores it into a
 * disposable, uniquely-named PostgreSQL database, sanity-checks the
 * result, and drops the disposable database. A backup is only proven
 * good once this succeeds — uploading it is not enough on its own.
 *
 * Deliberately separate from backup-database.ts's upload pipeline: this
 * module can be exercised on its own (unit tests, a local-only harness)
 * without ever needing the upload side to run first, and vice versa.
 *
 * ── Environment variables (CLI entrypoint only — see main()) ────────
 *
 * RESTORE_VERIFY_S3_ACCESS_KEY_ID / RESTORE_VERIFY_S3_SECRET_ACCESS_KEY (required)
 *   The RESTORER identity's credentials (tms-db-backup-restorer) —
 *   deliberately separate from BACKUP_S3_* (the uploader's), and never
 *   falls back to it.
 * RESTORE_VERIFY_S3_BUCKET / RESTORE_VERIFY_S3_REGION (required)
 * RESTORE_VERIFY_S3_KEY (required)
 *   The exact object key to fetch — this module never lists or scans
 *   the bucket; it verifies the one backup it's told to.
 * RESTORE_VERIFY_KMS_KEY_ID (required)
 *   Must match the key the object was encrypted under (the envelope
 *   header's own kmsKeyId is used for the actual Decrypt call; this is
 *   kept for config-completeness/validation, mirroring BACKUP_KMS_KEY_ID).
 * RESTORE_VERIFY_S3_ENDPOINT / RESTORE_VERIFY_S3_FORCE_PATH_STYLE (optional)
 *   Local/test S3-compatible endpoint override (e.g. s3rver).
 * RESTORE_VERIFY_DATABASE_URL (required)
 *   A connection URL for a role with CREATEDB (tms_backup_verify),
 *   pointed at an existing maintenance database (e.g. postgres) — NEVER
 *   at tms_dev/tms_local_test themselves. This script never reads
 *   DATABASE_URL/BACKUP_DATABASE_URL.
 * RESTORE_VERIFY_WORK_DIR (optional)
 *   Local temp directory for the downloaded/decrypted artifacts.
 *   Defaults to backend/.local-backups/restore-verify/ (gitignored).
 * RESTORE_VERIFY_FORBIDDEN_DB_NAMES (optional)
 *   Comma-separated extra names to forbid as a verification-database
 *   target, on top of the built-in list (tms_dev, tms_local_test,
 *   postgres, template0, template1).
 * PSQL_PATH / PG_RESTORE_PATH (optional)
 *   Full paths to the psql / pg_restore executables, same convention as
 *   PG_DUMP_PATH/PG_RESTORE_PATH in backup-database.ts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  createKmsClient,
  createS3Client,
  decryptDataKey,
  downloadObject,
  type MinimalAwsClient,
} from './backup-aws-clients';
import { decryptEnvelope, parseEnvelope, type EnvelopeHeader } from './backup-envelope';
import { acquireBackupLock, type LockHandle } from './backup-lock';
import { pgConnectionEnv } from './backup-database';

export const VERIFY_DB_PREFIX = 'tms_restore_verify_';
const SAFE_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const BUILTIN_FORBIDDEN_DB_NAMES = ['tms_dev', 'tms_local_test', 'postgres', 'template0', 'template1'];
// Task #10C.4A — a separate, narrower list for the *maintenance*
// connection's own target database: unlike the generated verification
// database, the maintenance connection is SUPPOSED to point at
// postgres/template1 (or an equivalent system database), so those
// names must stay allowed here — only actual application databases are
// forbidden as a maintenance-connection target.
const FORBIDDEN_MAINTENANCE_DB_NAMES = ['tms_dev', 'tms_local_test'];

// Deliberately conservative and structural, not an exact expected
// count — the real schema has 40+ tables; this only catches "the
// restore produced an obviously near-empty database," never schema
// drift as the application evolves.
const MIN_EXPECTED_TABLE_COUNT = 10;
// Core tables expected to have at least one row in any real
// environment (production or a seeded local-test database) — chosen
// for structural stability, not for any specific row count.
const REPRESENTATIVE_TABLES = ['organization', 'user'];
// Task #10C.4A — a small set of structurally-critical table NAMES that
// must exist after restore, independent of the floor-count check above.
// A count-only check can pass even if one specific important table is
// missing (as long as enough OTHER tables exist); checking these by
// name catches that. This is a schema-shape check, not a row-count
// check, so it stays stable as data volume changes.
const REQUIRED_TABLES = ['_prisma_migrations', 'organization', 'user', 'load'];

const DROP_DATABASE_MAX_ATTEMPTS = 3;
const DROP_DATABASE_RETRY_DELAY_MS = [200, 500, 1000];

export interface RestoreVerifySourceConfig {
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  kmsKeyId: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface RestoreVerifyConfig {
  source: RestoreVerifySourceConfig;
  maintenanceDatabaseUrl: string;
  psqlPath: string;
  pgRestorePath: string;
  workDir: string;
  forbiddenDatabaseNames: string[];
}

export interface RestoreVerifyDependencies {
  kmsClient?: MinimalAwsClient;
  s3Client?: MinimalAwsClient;
}

const REQUIRED_RESTORE_VERIFY_KEYS = [
  'RESTORE_VERIFY_S3_ACCESS_KEY_ID',
  'RESTORE_VERIFY_S3_SECRET_ACCESS_KEY',
  'RESTORE_VERIFY_S3_BUCKET',
  'RESTORE_VERIFY_S3_REGION',
  'RESTORE_VERIFY_S3_KEY',
  'RESTORE_VERIFY_KMS_KEY_ID',
  'RESTORE_VERIFY_DATABASE_URL',
] as const;

/** Shared object-construction for resolveRestoreVerifyConfig()/resolveRestoreVerifyConfigForKey() — see each for its own validation. */
function buildRestoreVerifyConfigFromSource(source: NodeJS.ProcessEnv, s3Key: string): RestoreVerifyConfig {
  return {
    source: {
      accessKeyId: source.RESTORE_VERIFY_S3_ACCESS_KEY_ID!,
      secretAccessKey: source.RESTORE_VERIFY_S3_SECRET_ACCESS_KEY!,
      bucket: source.RESTORE_VERIFY_S3_BUCKET!,
      region: source.RESTORE_VERIFY_S3_REGION!,
      key: s3Key,
      kmsKeyId: source.RESTORE_VERIFY_KMS_KEY_ID!,
      endpoint: source.RESTORE_VERIFY_S3_ENDPOINT?.trim() || undefined,
      forcePathStyle: source.RESTORE_VERIFY_S3_FORCE_PATH_STYLE === 'true' ? true : undefined,
    },
    maintenanceDatabaseUrl: source.RESTORE_VERIFY_DATABASE_URL!,
    psqlPath: source.PSQL_PATH?.trim() || 'psql',
    pgRestorePath: source.PG_RESTORE_PATH?.trim() || 'pg_restore',
    workDir: source.RESTORE_VERIFY_WORK_DIR?.trim() || join(__dirname, '..', '.local-backups', 'restore-verify'),
    forbiddenDatabaseNames: (source.RESTORE_VERIFY_FORBIDDEN_DB_NAMES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

/** Mirrors resolveBackupConfig()'s shape/philosophy in backup-database.ts: explicit-only, no fallback, fails before anything runs. */
export function resolveRestoreVerifyConfig(source: NodeJS.ProcessEnv): RestoreVerifyConfig {
  const missing = REQUIRED_RESTORE_VERIFY_KEYS.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run restore verification: required env var(s) not set: ${missing.join(', ')}. ` +
        'This script never falls back to BACKUP_S3_*/BACKUP_DATABASE_URL or any application variable — ' +
        'the restorer identity and maintenance connection must always be configured explicitly.',
    );
  }

  return buildRestoreVerifyConfigFromSource(source, source.RESTORE_VERIFY_S3_KEY!);
}

const REQUIRED_RESTORE_VERIFY_KEYS_FOR_ORCHESTRATION = REQUIRED_RESTORE_VERIFY_KEYS.filter(
  (key) => key !== 'RESTORE_VERIFY_S3_KEY',
);

/**
 * Task #10C.6C — variant of resolveRestoreVerifyConfig() for the
 * production backup+verify orchestration (backup-production.ts). The
 * object key to verify is never read from an env var here: it is always
 * the exact key the orchestration's own backup step just uploaded,
 * supplied directly as `s3Key`. This guarantees the verifier can never
 * drift onto a stale, operator-configured, or independently re-derived
 * key — RESTORE_VERIFY_S3_KEY (if present in `source`) is ignored.
 * Every other RESTORE_VERIFY_* variable is still required exactly as in
 * resolveRestoreVerifyConfig() — the restorer identity and maintenance
 * connection must always be configured explicitly, with no fallback to
 * the uploader's BACKUP_S3_ variables, BACKUP_DATABASE_URL, or any
 * application variable.
 */
export function resolveRestoreVerifyConfigForKey(source: NodeJS.ProcessEnv, s3Key: string): RestoreVerifyConfig {
  if (!s3Key) {
    throw new Error(
      'Refusing to run restore verification: no S3 object key was supplied — the orchestrator must pass the ' +
        'exact key produced by the backup step.',
    );
  }

  const missing = REQUIRED_RESTORE_VERIFY_KEYS_FOR_ORCHESTRATION.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run restore verification: required env var(s) not set: ${missing.join(', ')}. ` +
        'This script never falls back to BACKUP_S3_*/BACKUP_DATABASE_URL or any application variable — ' +
        'the restorer identity and maintenance connection must always be configured explicitly.',
    );
  }

  return buildRestoreVerifyConfigFromSource(source, s3Key);
}

/**
 * Generates a unique, unmistakably-scoped disposable database name.
 * Uniqueness comes from a UTC timestamp (second resolution) plus 4
 * random bytes — collision is not just unlikely but is independently
 * re-checked before use (see verificationDatabaseExists below), so
 * this function's output is never trusted blindly.
 */
export function generateVerificationDatabaseName(now: Date = new Date()): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}_${iso.slice(11, 19).replace(/:/g, '')}`;
  const random = randomBytes(4).toString('hex');
  return `${VERIFY_DB_PREFIX}${stamp}_${random}`;
}

/**
 * The hard safety gate every disposable-database name must pass before
 * any CREATE DATABASE / DROP DATABASE call. Fails closed: any name that
 * doesn't provably match the expected shape is rejected, not merely
 * "not obviously production."
 */
export function assertSafeVerificationDatabaseName(dbName: string, extraForbidden: string[] = []): void {
  if (!dbName || typeof dbName !== 'string') {
    throw new Error('Refusing to use verification database: name is empty or invalid.');
  }
  if (!dbName.startsWith(VERIFY_DB_PREFIX)) {
    throw new Error(
      `Refusing to use verification database "${dbName}": must start with the required prefix "${VERIFY_DB_PREFIX}".`,
    );
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(dbName)) {
    throw new Error(
      `Refusing to use verification database "${dbName}": must contain only lowercase letters, digits, and ` +
        'underscores, and start with a letter or underscore.',
    );
  }
  const lower = dbName.toLowerCase();
  const forbidden = [...BUILTIN_FORBIDDEN_DB_NAMES, ...extraForbidden.map((n) => n.toLowerCase())];
  if (forbidden.includes(lower)) {
    throw new Error(
      `Refusing to use verification database "${dbName}": matches a forbidden production/system database name.`,
    );
  }
}

/**
 * Task #10C.4A — the maintenance connection's own target database was
 * previously trusted entirely on the strength of a doc comment ("never
 * tms_dev/tms_local_test"), with no code enforcing it. A misconfigured
 * RESTORE_VERIFY_DATABASE_URL pointed at an application database would
 * have gone undetected. This closes that gap: it never touches
 * production data directly (only SELECT/CREATE DATABASE run against
 * it), but connecting there at all is against the design and is now
 * refused outright, exactly like the generated verification name is.
 */
export function assertSafeMaintenanceDatabaseName(dbName: string, extraForbidden: string[] = []): void {
  const lower = (dbName ?? '').toLowerCase();
  const forbidden = [...FORBIDDEN_MAINTENANCE_DB_NAMES, ...extraForbidden.map((n) => n.toLowerCase())];
  if (forbidden.includes(lower)) {
    throw new Error(
      `Refusing to use "${dbName}" as the maintenance connection's target database: this must be a system/maintenance ` +
        'database (e.g. "postgres"), never an application database. Check RESTORE_VERIFY_DATABASE_URL.',
    );
  }
}

/** PostgreSQL identifier-safe quoting (double-quote, double any embedded quote) — used for every CREATE/DROP DATABASE. */
export function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function databaseNameFromUrl(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '') || 'database';
}

interface PsqlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  launchError?: string;
}

/**
 * Runs one psql -c command against `targetDb`. Callers are responsible
 * for `sql` being fully safe to send as-is — psql's `-v`/`:'name'`
 * variable interpolation does NOT apply to `-c` command strings on this
 * psql build (18.1, confirmed empirically in Task #10C.4B: the colon
 * syntax reaches the server literally and is rejected as a syntax
 * error), so it is not offered here. Every current caller either uses a
 * fixed literal SQL string, or embeds a value that has already been
 * validated against a strict safe-character pattern immediately before
 * being embedded (see verificationDatabaseExists below) — never an
 * untrusted string spliced in directly.
 */
function runPsql(psqlPath: string, env: NodeJS.ProcessEnv, targetDb: string, sql: string): PsqlResult {
  const args = ['-v', 'ON_ERROR_STOP=1', '-d', targetDb, '-t', '-A', '-c', sql];

  const result = spawnSync(psqlPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    return { exitCode: null, stdout: '', stderr: '', launchError: result.error.message };
  }
  return {
    exitCode: result.status,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString().trim(),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString().trim(),
  };
}

export async function verificationDatabaseExists(
  psqlPath: string,
  env: NodeJS.ProcessEnv,
  maintenanceDbName: string,
  dbName: string,
): Promise<boolean> {
  // Defense in depth (Task #10C.4B): dbName is already validated by
  // assertSafeVerificationDatabaseName() before this function is ever
  // called (see runRestoreVerification), but re-validate immediately
  // before building this SQL string so this function stays safe even
  // if a future call site forgot to validate first. Embedding it
  // directly as a literal below is safe ONLY because this check
  // guarantees the value matches ^tms_restore_verify_[a-z0-9_]*$ — a
  // string that structurally cannot contain a quote, backslash,
  // semicolon, whitespace, or any other SQL metacharacter.
  assertSafeVerificationDatabaseName(dbName);
  const result = runPsql(psqlPath, env, maintenanceDbName, `SELECT 1 FROM pg_database WHERE datname = '${dbName}';`);
  if (result.launchError || result.exitCode !== 0) {
    throw new Error(`could not query pg_database: ${result.launchError ?? result.stderr}`);
  }
  return result.stdout.length > 0;
}

function createVerificationDatabase(
  psqlPath: string,
  env: NodeJS.ProcessEnv,
  maintenanceDbName: string,
  dbName: string,
): void {
  const result = runPsql(psqlPath, env, maintenanceDbName, `CREATE DATABASE ${quotePostgresIdentifier(dbName)};`);
  if (result.launchError || result.exitCode !== 0) {
    throw new Error(result.launchError ?? result.stderr);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Task #10C.4A — pg_restore and every sanity-check query run as
 * separate, synchronous, sequential psql/pg_restore processes, so no
 * code path in this module deliberately leaves a connection open
 * before this runs. But a client process exiting and the PostgreSQL
 * server fully reaping that backend are not perfectly synchronous —
 * there is a small, real window where DROP DATABASE can transiently
 * fail with "database is being accessed by other users" even though
 * nothing is actually still using it. A short bounded retry absorbs
 * exactly that race without ever touching any database other than the
 * one this run itself created, and without forcibly disconnecting
 * anything (no `WITH (FORCE)`) — a genuinely stuck external connection
 * still fails loudly after the retries are exhausted, exactly as
 * before.
 */
async function dropVerificationDatabase(
  psqlPath: string,
  env: NodeJS.ProcessEnv,
  maintenanceDbName: string,
  dbName: string,
): Promise<void> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < DROP_DATABASE_MAX_ATTEMPTS; attempt += 1) {
    const result = runPsql(psqlPath, env, maintenanceDbName, `DROP DATABASE ${quotePostgresIdentifier(dbName)};`);
    if (!result.launchError && result.exitCode === 0) {
      return;
    }
    lastError = result.launchError ?? result.stderr;
    if (attempt < DROP_DATABASE_MAX_ATTEMPTS - 1) {
      await delay(DROP_DATABASE_RETRY_DELAY_MS[attempt]);
    }
  }
  throw new Error(lastError ?? 'unknown error');
}

function runPgRestoreIntoDatabase(
  pgRestorePath: string,
  env: NodeJS.ProcessEnv,
  dumpPath: string,
  dbName: string,
): { success: boolean; message?: string } {
  // Never --clean: this only ever targets a brand-new, empty disposable
  // database, so there is nothing to clean, and --clean against a
  // database this code did not itself just create would be exactly the
  // kind of accidental-blast-radius mistake this module must not make.
  //
  // --single-transaction (Task #10C.4A): pg_restore's default is to
  // continue past per-object errors and only report them at the end —
  // which could leave a disposable database "mostly" restored with one
  // or two objects silently missing, exactly the kind of partial state
  // this verification exists to catch. Running the whole restore as one
  // transaction makes it all-or-nothing: any error rolls the entire
  // restore back, so a nonzero exit code here always means nothing was
  // partially applied. Safe here specifically because this always
  // targets a brand-new, empty, disposable database with no concurrent
  // writers.
  //
  // -d <dbName> (Task #10C.4C): unlike psql/pg_dump, pg_restore does NOT
  // fall back to PGDATABASE to decide it should restore into a live
  // database — confirmed by a real end-to-end run failing with "one of
  // -d/--dbname and -f/--file must be specified" even though PGDATABASE
  // was set correctly in `env`. `dbName` here is always the caller's
  // already-validated (assertSafeVerificationDatabaseName) disposable
  // database name — the same one CREATE DATABASE just created — never
  // the maintenance database and never derived from external input.
  const result = spawnSync(
    pgRestorePath,
    ['--no-owner', '--no-privileges', '--single-transaction', '-d', dbName, dumpPath],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) {
    return { success: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return { success: false, message: (result.stderr ?? Buffer.alloc(0)).toString().trim() || `exit code ${result.status}` };
  }
  return { success: true };
}

export interface SanityCheckOutcome {
  passed: boolean;
  details: string[];
}

/**
 * Structural, non-fragile checks: table count is "not obviously empty"
 * (a fixed conservative floor, not an exact count) and a couple of
 * always-populated core tables actually have rows — never an exact
 * business row count, which would break the moment production data
 * changes (i.e. every day).
 */
export function runSanityChecks(psqlPath: string, env: NodeJS.ProcessEnv, dbName: string): SanityCheckOutcome {
  const details: string[] = [];

  const currentDbResult = runPsql(psqlPath, env, dbName, 'SELECT current_database();');
  if (currentDbResult.exitCode !== 0 || currentDbResult.stdout !== dbName) {
    details.push(
      `FAIL: could not confirm the restore ran against the expected verification database ` +
        `(got "${currentDbResult.stdout || currentDbResult.stderr}").`,
    );
    return { passed: false, details };
  }
  details.push(`OK: connected to the expected verification database "${currentDbResult.stdout}".`);

  let passed = true;
  const tableCountResult = runPsql(
    psqlPath,
    env,
    dbName,
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';",
  );
  const tableCount = Number.parseInt(tableCountResult.stdout, 10);
  if (tableCountResult.exitCode !== 0 || !Number.isFinite(tableCount) || tableCount < MIN_EXPECTED_TABLE_COUNT) {
    details.push(
      `FAIL: public schema table count is ${Number.isFinite(tableCount) ? tableCount : 'unreadable'} ` +
        `(expected at least ${MIN_EXPECTED_TABLE_COUNT}).`,
    );
    passed = false;
  } else {
    details.push(`OK: public schema has ${tableCount} tables (>= ${MIN_EXPECTED_TABLE_COUNT}).`);
  }

  // A count-only floor can pass even if one specific important table is
  // missing, as long as enough *other* tables exist. This checks a
  // small set of structurally-critical tables by name — a schema-shape
  // fact, not a row count, so it stays stable as data volume changes.
  const missingRequiredTables: string[] = [];
  for (const table of REQUIRED_TABLES) {
    // `table` comes only from the REQUIRED_TABLES constant above — a
    // fixed, hardcoded list in this file, never external/runtime input
    // — so embedding it directly as a literal is safe. (Task #10C.4B:
    // this previously relied on the same broken psql `-v`/`:'var'`
    // mechanism as verificationDatabaseExists; see that function's own
    // comment for why it doesn't work via `-c` on this psql build.)
    const existsResult = runPsql(
      psqlPath,
      env,
      dbName,
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name = '${table}';`,
    );
    if (existsResult.exitCode !== 0 || existsResult.stdout.length === 0) {
      missingRequiredTables.push(table);
    }
  }
  if (missingRequiredTables.length > 0) {
    details.push(`FAIL: required table(s) missing from the restore: ${missingRequiredTables.join(', ')}.`);
    passed = false;
  } else {
    details.push(`OK: all required tables present (${REQUIRED_TABLES.join(', ')}).`);
  }

  for (const table of REPRESENTATIVE_TABLES) {
    const rowCountResult = runPsql(psqlPath, env, dbName, `SELECT count(*) FROM ${quotePostgresIdentifier(table)};`);
    const rowCount = Number.parseInt(rowCountResult.stdout, 10);
    if (rowCountResult.exitCode !== 0 || !Number.isFinite(rowCount)) {
      details.push(`FAIL: could not query representative table "${table}" — it may be missing from the restore.`);
      passed = false;
    } else if (rowCount <= 0) {
      details.push(`FAIL: representative table "${table}" is unexpectedly empty after restore.`);
      passed = false;
    } else {
      details.push(`OK: representative table "${table}" has ${rowCount} row(s).`);
    }
  }

  return { passed, details };
}

/**
 * Runs the full restore-verification pipeline and returns a process
 * exit code — never calls process.exit() itself. See this file's
 * top-of-file doc comment for the exact env-var contract when invoked
 * via main(); callers that construct RestoreVerifyConfig directly
 * (tests, the local-test harness, or a future caller right after a
 * successful upload) bypass env entirely.
 *
 * Cleanup ordering is deliberate: the plaintext dump is always deleted
 * in the `finally` block below, and if a disposable database was
 * created, dropping it is attempted there too — and a DROP failure
 * downgrades an otherwise-successful run to a failure (see the
 * `finally` block's own comment for why this requires an explicit
 * `return` there rather than relying on the value returned from `try`).
 */
export async function runRestoreVerification(
  config: RestoreVerifyConfig,
  deps: RestoreVerifyDependencies = {},
): Promise<number> {
  console.log('[restore-verify] Starting restore verification...');
  console.log(`[restore-verify] Source: s3://${config.source.bucket}/${config.source.key} (region=${config.source.region})`);

  try {
    if (!existsSync(config.workDir)) {
      mkdirSync(config.workDir, { recursive: true });
    }
  } catch (error) {
    console.error(`[restore-verify] Failed to prepare work directory: ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  const maintenanceDbName = databaseNameFromUrl(config.maintenanceDatabaseUrl);
  try {
    assertSafeMaintenanceDatabaseName(maintenanceDbName, config.forbiddenDatabaseNames);
  } catch (error) {
    console.error(`[restore-verify] ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  let lock: LockHandle;
  try {
    lock = acquireBackupLock(join(config.workDir, '.restore-verify.lock'));
  } catch (error) {
    console.error(`[restore-verify] ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  let exitCode = 1;
  let plaintextPath: string | undefined;
  let verifyDbName: string | undefined;
  let dbCreated = false;
  let plaintextCleanupFailed = false;
  const maintenanceEnv = pgConnectionEnv(config.maintenanceDatabaseUrl);

  try {
    const s3Client =
      deps.s3Client ??
      createS3Client({
        region: config.source.region,
        accessKeyId: config.source.accessKeyId,
        secretAccessKey: config.source.secretAccessKey,
        endpoint: config.source.endpoint,
        forcePathStyle: config.source.forcePathStyle,
      });

    let envelope: Buffer;
    try {
      console.log(`[restore-verify] Downloading s3://${config.source.bucket}/${config.source.key} ...`);
      envelope = await downloadObject(s3Client, config.source.bucket, config.source.key);
    } catch (error) {
      console.error(`[restore-verify] S3 download failed: ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }

    let header: EnvelopeHeader;
    let ciphertext: Buffer;
    try {
      ({ header, ciphertext } = parseEnvelope(envelope));
    } catch (error) {
      console.error(`[restore-verify] Envelope parsing failed: ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }

    const kmsClient =
      deps.kmsClient ?? createKmsClient(config.source.region, config.source.accessKeyId, config.source.secretAccessKey);
    let plaintextDataKey: Buffer;
    try {
      plaintextDataKey = await decryptDataKey(kmsClient, Buffer.from(header.encryptedDataKey, 'base64'), header.kmsKeyId);
    } catch (error) {
      console.error(`[restore-verify] KMS Decrypt failed: ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }

    let plaintext: Buffer;
    try {
      plaintext = decryptEnvelope(header, ciphertext, plaintextDataKey);
    } catch (error) {
      console.error(
        `[restore-verify] AES-256-GCM decryption failed (authentication error or corrupt data): ${(error as Error).message} — FAILURE.`,
      );
      return exitCode;
    } finally {
      plaintextDataKey.fill(0);
    }

    plaintextPath = join(config.workDir, `restore-verify-${Date.now()}.dump`);
    try {
      writeFileSync(plaintextPath, plaintext);
    } catch (error) {
      console.error(`[restore-verify] Failed to write temporary plaintext dump: ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }
    console.log(`[restore-verify] Decrypted dump written to a temporary location (${plaintext.length} bytes).`);

    verifyDbName = generateVerificationDatabaseName();
    try {
      assertSafeVerificationDatabaseName(verifyDbName, config.forbiddenDatabaseNames);
    } catch (error) {
      console.error(`[restore-verify] ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }
    console.log(`[restore-verify] Generated verification database name: ${verifyDbName}`);

    let alreadyExists: boolean;
    try {
      alreadyExists = await verificationDatabaseExists(config.psqlPath, maintenanceEnv, maintenanceDbName, verifyDbName);
    } catch (error) {
      console.error(
        `[restore-verify] Could not confirm the verification database name is unused: ${(error as Error).message} ` +
          '— FAILURE (failing closed).',
      );
      return exitCode;
    }
    if (alreadyExists) {
      console.error(
        `[restore-verify] Refusing to proceed: a database named "${verifyDbName}" already exists — FAILURE (failing closed).`,
      );
      return exitCode;
    }

    try {
      createVerificationDatabase(config.psqlPath, maintenanceEnv, maintenanceDbName, verifyDbName);
      dbCreated = true;
    } catch (error) {
      console.error(`[restore-verify] CREATE DATABASE failed: ${(error as Error).message} — FAILURE.`);
      return exitCode;
    }
    console.log(`[restore-verify] Created disposable verification database "${verifyDbName}".`);

    const verifyDbUrl = new URL(config.maintenanceDatabaseUrl);
    verifyDbUrl.pathname = `/${verifyDbName}`;
    const restoreEnv = pgConnectionEnv(verifyDbUrl.toString());

    const restoreResult = runPgRestoreIntoDatabase(config.pgRestorePath, restoreEnv, plaintextPath, verifyDbName);
    if (!restoreResult.success) {
      console.error(`[restore-verify] pg_restore failed: ${restoreResult.message} — FAILURE.`);
      return exitCode;
    }
    console.log('[restore-verify] pg_restore completed.');

    const sanity = runSanityChecks(config.psqlPath, restoreEnv, verifyDbName);
    for (const line of sanity.details) {
      console.log(`[restore-verify] ${line}`);
    }
    if (!sanity.passed) {
      console.error('[restore-verify] Sanity checks failed — FAILURE.');
      return exitCode;
    }

    console.log('[restore-verify] SUCCESS — backup verified restorable.');
    exitCode = 0;
    return exitCode;
  } catch (error) {
    console.error(`[restore-verify] Unexpected error: ${(error as Error).message} — FAILURE.`);
    return exitCode;
  } finally {
    // The plaintext dump must never outlive this run, regardless of outcome.
    if (plaintextPath && existsSync(plaintextPath)) {
      try {
        unlinkSync(plaintextPath);
      } catch (cleanupError) {
        console.error(`[restore-verify] Warning: failed to remove temporary plaintext dump: ${(cleanupError as Error).message}`);
        plaintextCleanupFailed = true;
      }
    }

    // A `return` here overrides whatever `try`/`catch` already returned
    // (standard JS/TS finally semantics) — this is deliberate: it's how
    // a DROP DATABASE failure downgrades an otherwise-successful run to
    // a failure, per this task's explicit "make that a loud failure
    // rather than silently succeeding" requirement.
    if (dbCreated && verifyDbName) {
      try {
        await dropVerificationDatabase(config.psqlPath, maintenanceEnv, maintenanceDbName, verifyDbName);
        console.log(`[restore-verify] Dropped disposable verification database "${verifyDbName}".`);
      } catch (dropError) {
        console.error(
          `[restore-verify] *** CLEANUP FAILURE *** could not drop verification database "${verifyDbName}": ` +
            `${(dropError as Error).message} — this requires manual cleanup. Treating the run as FAILED.`,
        );
        lock.release();
        return 1;
      }
    }

    if (plaintextCleanupFailed) {
      console.error(
        '[restore-verify] Treating the run as FAILED because the temporary plaintext dump could not be removed ' +
          '— see the warning above. Manual cleanup of that file is required.',
      );
      lock.release();
      return 1;
    }

    lock.release();
    return exitCode;
  }
}

/* istanbul ignore next -- thin CLI entrypoint, exercised via the exported functions instead */
function main(): void {
  let config: RestoreVerifyConfig;
  try {
    config = resolveRestoreVerifyConfig(process.env);
  } catch (error) {
    console.error(`[restore-verify] Configuration error: ${(error as Error).message}`);
    process.exit(1);
  }
  runRestoreVerification(config)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[restore-verify] Unexpected fatal error: ${(error as Error).message} — FAILURE.`);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}
