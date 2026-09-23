/**
 * Task #10A/#10C.2 — safe, non-production test harness for
 * scripts/backup-database.ts, extended to exercise the full encrypt +
 * upload pipeline end to end, entirely without touching real AWS:
 *
 *  - PostgreSQL: real tms_local_test database, real tms_backup_dump
 *    role (unchanged from Task #10A.3) — never tms_dev.
 *  - KMS: a STUB client (see stubKmsClient below). This harness never
 *    calls the real AWS KMS key (alias/tms-db-backups-prod) — a real-
 *    KMS integration check against the approved backup identities is a
 *    separate, explicit follow-up, not something this harness does on
 *    its own initiative.
 *  - S3: a real, but entirely local and ephemeral, s3rver instance
 *    (same package/pattern as scripts/start-local-s3.ts) bound to
 *    127.0.0.1 on its own port with its own throwaway bucket. Both the
 *    endpoint and the bucket name are hardcoded literals below, never
 *    read from any environment variable — this harness cannot be
 *    redirected at a real AWS bucket, production or otherwise, by any
 *    environment configuration. If the local S3 server fails to start,
 *    the run fails closed (throws) rather than falling back to
 *    anything real.
 *
 * After a reported-successful run, this harness independently fetches
 * the uploaded object back from the local s3rver, parses the TMSK
 * envelope, decrypts it with the same stub data key, and checks the
 * result starts with pg_dump's own custom-format magic header
 * ("PGDMP") — proof the real, full pipeline (dump -> encrypt -> upload)
 * produces a genuinely restorable artifact, not just that each step
 * exited 0.
 *
 * Usage: npm run backup:database:test-local
 */
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import S3rver from 's3rver';
import { runBackup, type BackupConfig, type MinimalAwsClient } from './backup-database';
import { decryptEnvelope, parseEnvelope } from './backup-envelope';

// Same reasoning as scripts/apply-rls.ts's own identical line: nothing
// loads environment variables for a standalone ts-node script by
// default, unlike the Prisma CLI.
loadEnv({ path: join(__dirname, '..', '.env') });

const LOCAL_TEST_DB_NAME = 'tms_local_test';
const BACKUP_ROLE_NAME = 'tms_backup_dump';
// Deny-list, independent of the exact-match check above — catches this
// repo's actual production database name (tms_dev) and anything
// production-flavored even if LOCAL_TEST_DB_NAME were ever renamed to
// something that coincidentally still passed the exact-match check.
const FORBIDDEN_MARKERS = ['prod', 'tms_dev'];

// Hardcoded literals, never derived from any environment variable or
// caller input — this harness can never be pointed at a real AWS S3
// bucket, by design, regardless of what backend/.env contains.
const LOCAL_S3_HOST = '127.0.0.1';
const LOCAL_S3_PORT = 9001; // distinct from scripts/start-local-s3.ts's port 9000
const LOCAL_S3_BUCKET = 'tms-db-backups-local-test';
const LOCAL_S3_DATA_DIR = join(__dirname, '..', '.local-backups', 'test-s3-data');
const LOCAL_KMS_KEY_ID = 'local-test-stub-key'; // never sent to a real KMS call
// Task #10C.3.1 — a single source of truth for the prefix, used both in
// the BackupConfig passed to runBackup() and in this harness's own
// post-upload verification listing below, so the two can never drift
// out of sync with each other.
const LOCAL_S3_PREFIX = 'test';

function assertPgDumpMagicHeader(buffer: Buffer): void {
  const magic = buffer.subarray(0, 5).toString('latin1');
  if (magic !== 'PGDMP') {
    throw new Error(
      `Decrypted artifact does not start with pg_dump's custom-format magic header ("PGDMP") — ` +
        `got "${magic}" instead. The pipeline did not produce a valid, restorable backup.`,
    );
  }
}

/**
 * Extracted so it can be unit-tested directly (backup-database.local-
 * test.spec.ts) against production-like values without running the
 * full pg_dump/KMS/S3 pipeline. Exact-match required for the database
 * name; the bucket only needs to avoid the forbidden-marker deny-list
 * since (unlike the database) it's a hardcoded literal in this file,
 * not read from anything a caller could influence.
 */
export function assertSafeLocalDatabaseName(dbName: string): void {
  if (dbName !== LOCAL_TEST_DB_NAME) {
    throw new Error(
      `Refusing to run: resolved database name "${dbName}" is not "${LOCAL_TEST_DB_NAME}". ` +
        'Value not printed beyond the database name itself.',
    );
  }
  const lower = dbName.toLowerCase();
  const matched = FORBIDDEN_MARKERS.find((marker) => lower.includes(marker));
  if (matched) {
    throw new Error(
      `Refusing to run: resolved database name "${dbName}" matches the forbidden marker "${matched}". ` +
        'This harness must never be able to target a production-like database.',
    );
  }
}

export function assertSafeLocalBucketName(bucket: string): void {
  const lower = bucket.toLowerCase();
  const matched = FORBIDDEN_MARKERS.find((marker) => lower.includes(marker));
  if (matched) {
    throw new Error(`Refusing to run: bucket "${bucket}" matches the forbidden marker "${matched}".`);
  }
}

async function main(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error(
      '[backup:test] DATABASE_URL is not set in backend/.env — cannot derive connection details ' +
        'for the local test database.',
    );
    process.exit(1);
  }

  const url = new URL(baseUrl!);
  url.pathname = `/${LOCAL_TEST_DB_NAME}`;
  url.username = BACKUP_ROLE_NAME;
  url.password = ''; // never carry a password here — relies on pgpass.conf
  const resolvedDbName = url.pathname.replace(/^\//, '');

  try {
    assertSafeLocalDatabaseName(resolvedDbName);
    // Defense in depth: even though LOCAL_S3_BUCKET is a hardcoded
    // literal above (never env-derived), re-validate it against the
    // same forbidden-marker discipline, so a future edit that
    // accidentally reuses a production-looking name here is caught.
    assertSafeLocalBucketName(LOCAL_S3_BUCKET);
  } catch (error) {
    console.error(`[backup:test] ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(
    `[backup:test] Verified target database: ${resolvedDbName} (host=${url.hostname}, ` +
      `port=${url.port || '5432'}, role=${url.username}) — confirmed NOT production. Proceeding.`,
  );
  console.log(
    `[backup:test] S3 destination is a local, ephemeral s3rver instance at ` +
      `http://${LOCAL_S3_HOST}:${LOCAL_S3_PORT}/${LOCAL_S3_BUCKET} — never real AWS S3.`,
  );

  const stubDataKey = randomBytes(32);
  const stubKmsClient: MinimalAwsClient = {
    async send() {
      return {
        Plaintext: stubDataKey,
        CiphertextBlob: Buffer.from('local-test-stub-encrypted-data-key', 'utf8'),
      };
    },
  };

  const server = new S3rver({
    address: LOCAL_S3_HOST,
    port: LOCAL_S3_PORT,
    directory: LOCAL_S3_DATA_DIR,
    silent: true,
    vhostBuckets: false,
    configureBuckets: [{ name: LOCAL_S3_BUCKET, configs: [] }],
  });

  let serverStarted = false;
  try {
    await server.run();
    serverStarted = true;
    console.log(`[backup:test] Local S3-compatible server started on http://${LOCAL_S3_HOST}:${LOCAL_S3_PORT}`);

    const config: BackupConfig = {
      databaseUrl: url.toString(),
      outputDir: join(__dirname, '..', '.local-backups', 'test'),
      pgDumpPath: process.env.PG_DUMP_PATH?.trim() || 'pg_dump',
      pgRestorePath: process.env.PG_RESTORE_PATH?.trim() || 'pg_restore',
      kmsKeyId: LOCAL_KMS_KEY_ID,
      s3: {
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        bucket: LOCAL_S3_BUCKET,
        region: 'us-east-1',
        prefix: LOCAL_S3_PREFIX,
        endpoint: `http://${LOCAL_S3_HOST}:${LOCAL_S3_PORT}`,
        forcePathStyle: true,
      },
    };

    const exitCode = await runBackup(config, { kmsClient: stubKmsClient });
    if (exitCode !== 0) {
      console.error(`[backup:test] Backup pipeline FAILED with exit code ${exitCode}.`);
      process.exitCode = exitCode;
      return;
    }

    console.log('[backup:test] Fetching the uploaded object back from local S3 for independent verification...');
    const verifyClient = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
      endpoint: `http://${LOCAL_S3_HOST}:${LOCAL_S3_PORT}`,
      forcePathStyle: true,
    });
    const listing = await verifyClient.send(
      new ListObjectsV2Command({ Bucket: LOCAL_S3_BUCKET, Prefix: `${LOCAL_S3_PREFIX}/` }),
    );
    const uploadedKey = listing.Contents?.[0]?.Key;
    if (!uploadedKey) {
      throw new Error('No object found in the local S3 bucket after a reported-successful upload.');
    }

    const getResult = await verifyClient.send(
      new GetObjectCommand({ Bucket: LOCAL_S3_BUCKET, Key: uploadedKey }),
    );
    const bodyBytes = await getResult.Body!.transformToByteArray();
    const envelopeBuffer = Buffer.from(bodyBytes);
    const { header, ciphertext } = parseEnvelope(envelopeBuffer);
    const decrypted = decryptEnvelope(header, ciphertext, stubDataKey);
    assertPgDumpMagicHeader(decrypted);

    console.log(
      `[backup:test] SUCCESS — uploaded object "${uploadedKey}" decrypts to a valid pg_dump ` +
        `custom-format artifact (${decrypted.length} bytes). Full pipeline verified end to end, ` +
        'entirely against local/non-production resources.',
    );
  } catch (error) {
    console.error(`[backup:test] FAILURE: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    if (serverStarted) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

/* istanbul ignore next -- thin CLI entrypoint; the guard logic above is tested directly */
if (require.main === module) {
  main();
}
