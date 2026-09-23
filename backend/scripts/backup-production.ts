/**
 * Task #10C.6C — production backup + restore-verification orchestration.
 * Calls the existing backup and restore-verification pipelines
 * in-process (no shelling out to two independent npm commands), so the
 * restore verifier always operates on the exact S3 object this run's
 * backup step just produced — never a re-derived or independently
 * re-timestamped key.
 *
 * ── Execution order ──────────────────────────────────────────────────
 *
 * 1. Resolve production backup config (resolveBackupConfig — same
 *    explicit, no-fallback config resolution backup-database.ts's own
 *    CLI entrypoint uses).
 * 2. Resolve the actual target database name the same way
 *    backup-database.ts does internally (databaseNameFromUrl) and pass
 *    it to assertProductionDatabaseTarget() — this MUST throw before
 *    pg_dump ever runs unless the resolved database is exactly
 *    "tms_dev".
 * 3. Acquire ONE lock for the entire sequence (shared across both the
 *    backup and the restore-verification steps) — not one lock per
 *    step. Released in a `finally` block, so any failure at any point
 *    still releases it.
 * 4. Run the backup (runBackup from backup-database.ts), capturing the
 *    exact uploaded S3 key via its onUploadSuccess dependency hook — no
 *    second Date.now()/new Date() call is ever used to re-derive it.
 * 5. If the backup failed, return its exit code immediately — restore
 *    verification is never invoked.
 * 6. Resolve restore-verification config (resolveRestoreVerifyConfigForKey
 *    from backup-restore-verify.ts) using the RESTORE_VERIFY_* env vars
 *    (a distinct restorer identity and maintenance-database connection
 *    — never BACKUP_DATABASE_URL or the uploader's credentials) plus the
 *    exact key captured in step 4.
 * 7. Run restore verification (runRestoreVerification) against that
 *    exact object — this reuses that module's own existing safety
 *    protections (tms_backup_verify role, postgres maintenance
 *    database, generated disposable-database names) unchanged.
 * 8. Release the shared lock.
 *
 * ── Environment variables ────────────────────────────────────────────
 *
 * Everything resolveBackupConfig() requires (see backup-database.ts's
 * own doc comment): BACKUP_DATABASE_URL, BACKUP_S3_ACCESS_KEY_ID,
 * BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_BUCKET, BACKUP_S3_REGION,
 * BACKUP_KMS_KEY_ID, and optionally BACKUP_OUTPUT_DIR/BACKUP_S3_PREFIX/
 * PG_DUMP_PATH/PG_RESTORE_PATH.
 *
 * Plus everything resolveRestoreVerifyConfigForKey() requires (see
 * backup-restore-verify.ts's own doc comment) EXCEPT RESTORE_VERIFY_S3_KEY,
 * which this script always supplies itself: RESTORE_VERIFY_S3_ACCESS_KEY_ID,
 * RESTORE_VERIFY_S3_SECRET_ACCESS_KEY, RESTORE_VERIFY_S3_BUCKET,
 * RESTORE_VERIFY_S3_REGION, RESTORE_VERIFY_KMS_KEY_ID,
 * RESTORE_VERIFY_DATABASE_URL, and optionally RESTORE_VERIFY_WORK_DIR/
 * RESTORE_VERIFY_FORBIDDEN_DB_NAMES/PSQL_PATH/PG_RESTORE_PATH.
 *
 * This script never falls back to a plain DATABASE_URL, an interactive
 * AWS CLI profile, the uploader's credentials for restore verification,
 * tms_local_test, or any existing backend/.env production secret — every
 * one of the variables above must be supplied explicitly to this
 * process's own environment.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveBackupConfig,
  runBackup,
  databaseNameFromUrl,
  type BackupConfig,
  type BackupDependencies,
  type BackupUploadSuccessInfo,
} from './backup-database';
import {
  resolveRestoreVerifyConfigForKey,
  runRestoreVerification,
  type RestoreVerifyDependencies,
} from './backup-restore-verify';
import { assertProductionDatabaseTarget } from './backup-production-guard';
import { acquireBackupLock, type LockHandle } from './backup-lock';

const PRODUCTION_LOCK_FILE_NAME = '.backup-production.lock';

export interface ProductionBackupDependencies {
  backup?: BackupDependencies;
  restoreVerify?: RestoreVerifyDependencies;
}

/**
 * Runs the full backup+verify sequence and returns a process exit code —
 * never calls process.exit() itself. `env` is accepted as a parameter
 * (rather than reading process.env internally) so tests can supply a
 * fully isolated, fake environment.
 */
export async function runProductionBackupAndVerify(
  env: NodeJS.ProcessEnv,
  deps: ProductionBackupDependencies = {},
): Promise<number> {
  console.log('[backup-production] Starting production backup + restore verification...');

  let backupConfig: BackupConfig;
  try {
    backupConfig = resolveBackupConfig(env);
  } catch (error) {
    console.error(`[backup-production] Configuration error: ${(error as Error).message}`);
    return 1;
  }

  // ---- Fail-closed production target guard — before pg_dump ever runs ----
  const resolvedDbName = databaseNameFromUrl(backupConfig.databaseUrl);
  try {
    assertProductionDatabaseTarget(resolvedDbName);
  } catch (error) {
    console.error(`[backup-production] ${(error as Error).message}`);
    return 1;
  }

  try {
    if (!existsSync(backupConfig.outputDir)) {
      mkdirSync(backupConfig.outputDir, { recursive: true });
    }
  } catch (error) {
    console.error(`[backup-production] Failed to prepare output directory: ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  // ---- One shared lock for the entire backup+verify sequence ----
  let lock: LockHandle;
  try {
    lock = acquireBackupLock(join(backupConfig.outputDir, PRODUCTION_LOCK_FILE_NAME));
  } catch (error) {
    console.error(`[backup-production] ${(error as Error).message} — FAILURE.`);
    return 1;
  }

  try {
    let uploadedS3Key: string | undefined;
    const backupDeps: BackupDependencies = {
      ...deps.backup,
      onUploadSuccess: (info: BackupUploadSuccessInfo) => {
        uploadedS3Key = info.s3Key;
        deps.backup?.onUploadSuccess?.(info);
      },
    };

    console.log(`[backup-production] Running backup against "${resolvedDbName}"...`);
    const backupExitCode = await runBackup(backupConfig, backupDeps);
    if (backupExitCode !== 0) {
      console.error('[backup-production] Backup failed — restore verification will NOT be run. FAILURE.');
      return backupExitCode;
    }
    if (!uploadedS3Key) {
      console.error(
        '[backup-production] Backup reported success but no S3 key was captured — refusing to run restore ' +
          'verification against an unknown object. FAILURE (failing closed).',
      );
      return 1;
    }
    console.log(`[backup-production] Backup succeeded — uploaded key: ${uploadedS3Key}`);

    let restoreVerifyConfig;
    try {
      restoreVerifyConfig = resolveRestoreVerifyConfigForKey(env, uploadedS3Key);
    } catch (error) {
      console.error(`[backup-production] Configuration error: ${(error as Error).message}`);
      return 1;
    }

    console.log('[backup-production] Running restore verification against the exact uploaded object...');
    const verifyExitCode = await runRestoreVerification(restoreVerifyConfig, deps.restoreVerify);
    if (verifyExitCode !== 0) {
      console.error('[backup-production] Restore verification failed. FAILURE.');
      return verifyExitCode;
    }

    console.log('[backup-production] SUCCESS — backup uploaded and restore-verified.');
    return 0;
  } catch (error) {
    console.error(`[backup-production] Unexpected error: ${(error as Error).message} — FAILURE.`);
    return 1;
  } finally {
    lock.release();
  }
}

/* istanbul ignore next -- thin CLI entrypoint, exercised via the exported function instead */
function main(): void {
  runProductionBackupAndVerify(process.env)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[backup-production] Unexpected fatal error: ${(error as Error).message} — FAILURE.`);
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}
