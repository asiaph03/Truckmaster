/**
 * Task #10C.6C — fail-closed target guard for the production backup
 * orchestration (see backup-production.ts). Every other database-name
 * guard in this codebase (assertSafeVerificationDatabaseName,
 * assertSafeMaintenanceDatabaseName, assertSafeLocalDatabaseName) is a
 * deny-list against a small forbidden set, because those call sites
 * genuinely accept many different safe values (a freshly generated
 * disposable name, tms_local_test, etc.) and only need to rule out a
 * few specific bad ones. Production is the opposite shape: there is
 * exactly one correct target, so this allow-lists that single name
 * instead of trying to enumerate every possible wrong one — an empty
 * string, tms_local_test, postgres, template0, template1, or any other
 * value are all rejected by the same equality check, with nothing to
 * keep in sync as new "obviously wrong" names are thought of later.
 *
 * Deliberately lives in its own module rather than inside
 * resolveBackupConfig()/backup-database.ts: that file must stay usable
 * against tms_local_test for every existing test and local-run
 * scenario, so a tms_dev-only restriction cannot live there. This
 * mirrors the same reasoning already used for assertSafeLocalDatabaseName
 * (lives in backup-database.local-test.ts, the test-specific caller,
 * not the shared library) — the safety check belongs with the
 * production-specific caller, not the generic pipeline.
 */

export const PRODUCTION_DATABASE_NAME = 'tms_dev';

/**
 * Throws unless `resolvedDbName` is exactly "tms_dev". Callers must pass
 * the actual resolved database name (e.g. backup-database.ts's own
 * databaseNameFromUrl(config.databaseUrl)) — never the raw
 * BACKUP_DATABASE_URL string — and must call this before runBackup() is
 * invoked, so a misconfigured target is refused before pg_dump ever
 * touches Postgres.
 */
export function assertProductionDatabaseTarget(resolvedDbName: string): void {
  if (resolvedDbName !== PRODUCTION_DATABASE_NAME) {
    throw new Error(
      `Refusing to run production backup: resolved database is "${resolvedDbName}", expected exactly "${PRODUCTION_DATABASE_NAME}".`,
    );
  }
}
