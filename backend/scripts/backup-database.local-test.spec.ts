import { assertSafeLocalBucketName, assertSafeLocalDatabaseName } from './backup-database.local-test';

/**
 * Task #10C.2 — proves the local-test harness's own safety guards in
 * isolation, without running pg_dump, KMS, or S3 at all. Importing this
 * module does not execute the harness's main() (guarded by
 * `if (require.main === module)`), so this spec only ever exercises the
 * two pure guard functions below.
 */

describe('assertSafeLocalDatabaseName — production markers are rejected', () => {
  it('accepts the expected local test database name', () => {
    expect(() => assertSafeLocalDatabaseName('tms_local_test')).not.toThrow();
  });

  it("rejects this repository's actual production database name (tms_dev)", () => {
    expect(() => assertSafeLocalDatabaseName('tms_dev')).toThrow(/tms_dev|not "tms_local_test"/i);
  });

  it('rejects any name containing "prod"', () => {
    expect(() => assertSafeLocalDatabaseName('tms_test_prod')).toThrow();
  });

  it('rejects an unrelated database name that is neither the expected name nor a known marker', () => {
    expect(() => assertSafeLocalDatabaseName('some_other_db')).toThrow(/not "tms_local_test"/);
  });
});

describe('assertSafeLocalBucketName — production markers are rejected', () => {
  it('accepts the expected local test bucket name', () => {
    expect(() => assertSafeLocalBucketName('tms-db-backups-local-test')).not.toThrow();
  });

  it("rejects this repository's actual production backup bucket name", () => {
    expect(() => assertSafeLocalBucketName('tms-db-backups-prod-2026')).toThrow(/prod/i);
  });

  it('rejects any bucket name containing "prod", regardless of surrounding text', () => {
    expect(() => assertSafeLocalBucketName('some-prod-bucket')).toThrow(/prod/i);
  });
});
