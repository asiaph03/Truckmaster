import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DecryptCommand } from '@aws-sdk/client-kms';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { spawnSync } from 'node:child_process';
const mockSpawnSync = spawnSync as jest.Mock;

import {
  assertSafeMaintenanceDatabaseName,
  assertSafeVerificationDatabaseName,
  generateVerificationDatabaseName,
  quotePostgresIdentifier,
  resolveRestoreVerifyConfig,
  resolveRestoreVerifyConfigForKey,
  runRestoreVerification,
  runSanityChecks,
  verificationDatabaseExists,
  VERIFY_DB_PREFIX,
  type RestoreVerifyConfig,
} from './backup-restore-verify';
import { encryptToEnvelope } from './backup-envelope';
import type { MinimalAwsClient } from './backup-aws-clients';

const FAKE_PSQL = 'fake-psql';
const FAKE_PG_RESTORE = 'fake-pg_restore';

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

/**
 * Routes the mocked spawnSync calls made by runPsql()/pg_restore based
 * on the SQL text / executable, without ever needing a real PostgreSQL
 * connection. Mirrors real psql behavior for `current_database()` by
 * echoing back whichever `-d <dbname>` the call targeted.
 */
function makeSpawnSyncRouter(overrides: {
  pgRestore?: { status?: number | null; errorMessage?: string; stderr?: string };
  createDatabase?: { status?: number; errorMessage?: string; stderr?: string };
  dropDatabase?: { status?: number; errorMessage?: string; stderr?: string };
  existsQueryStdout?: string;
  tableCount?: number;
  rowCounts?: Record<string, number>;
  missingRequiredTables?: string[];
} = {}) {
  return (cmd: string, args?: readonly string[]) => {
    const argv = args ?? [];
    if (cmd === FAKE_PG_RESTORE) {
      const cfg = overrides.pgRestore ?? {};
      if (cfg.errorMessage) {
        return { error: new Error(cfg.errorMessage) };
      }
      return { status: cfg.status ?? 0, stdout: buf(''), stderr: buf(cfg.stderr ?? '') };
    }

    const dIndex = argv.indexOf('-d');
    const targetDb = dIndex >= 0 ? argv[dIndex + 1] : '';
    const cIndex = argv.indexOf('-c');
    const sql = cIndex >= 0 ? argv[cIndex + 1] : '';

    // Task #10C.4B: the real implementation no longer uses psql's
    // -v/:'var' mechanism (confirmed broken for -c strings on psql
    // 18.1) — every value is now embedded directly as a literal after
    // validation. This mock parses that literal straight out of the SQL
    // text, which also means these tests exercise the exact SQL string
    // the real code builds, not a separate `-v` side-channel.
    if (sql.includes('pg_database')) {
      // Regression guard: the old broken syntax must never return.
      if (sql.includes(":'")) {
        throw new Error(`Test setup error: SQL still uses the broken :'var' syntax: ${sql}`);
      }
      return { status: 0, stdout: buf(overrides.existsQueryStdout ?? ''), stderr: buf('') };
    }
    if (sql.startsWith('CREATE DATABASE')) {
      const cfg = overrides.createDatabase ?? {};
      if (cfg.errorMessage) return { error: new Error(cfg.errorMessage) };
      return { status: cfg.status ?? 0, stdout: buf(''), stderr: buf(cfg.stderr ?? '') };
    }
    if (sql.startsWith('DROP DATABASE')) {
      const cfg = overrides.dropDatabase ?? {};
      if (cfg.errorMessage) return { error: new Error(cfg.errorMessage) };
      return { status: cfg.status ?? 0, stdout: buf(''), stderr: buf(cfg.stderr ?? '') };
    }
    if (sql.includes('current_database')) {
      return { status: 0, stdout: buf(targetDb), stderr: buf('') };
    }
    // Per-table existence check (required-tables check) — distinct from
    // the plain COUNT query below; both mention "information_schema.tables".
    if (sql.startsWith('SELECT 1 FROM information_schema.tables')) {
      if (sql.includes(":'")) {
        throw new Error(`Test setup error: SQL still uses the broken :'var' syntax: ${sql}`);
      }
      const match = sql.match(/table_name = '([^']*)'/);
      const table = match?.[1] ?? '';
      const missing = (overrides.missingRequiredTables ?? []).includes(table);
      return { status: 0, stdout: buf(missing ? '' : '1'), stderr: buf('') };
    }
    if (sql.includes('information_schema.tables')) {
      return { status: 0, stdout: buf(String(overrides.tableCount ?? 20)), stderr: buf('') };
    }
    for (const [table, count] of Object.entries(overrides.rowCounts ?? {})) {
      if (sql.includes(`"${table}"`)) {
        return { status: 0, stdout: buf(String(count)), stderr: buf('') };
      }
    }
    return { status: 0, stdout: buf('5'), stderr: buf('') }; // default: representative tables have rows
  };
}

const DATA_KEY = Buffer.alloc(32, 0x42);
const PLAINTEXT_DUMP = Buffer.from('PGDMP-fake-dump-for-restore-verify-tests');

function buildFixtureEnvelope(kmsKeyId = 'test-kms-key'): Buffer {
  return encryptToEnvelope({
    plaintext: PLAINTEXT_DUMP,
    plaintextDataKey: DATA_KEY,
    encryptedDataKey: Buffer.from('fake-kms-ciphertext-blob'),
    kmsKeyId,
    sourceDatabase: 'tms_local_test',
  });
}

function makeS3Client(envelope: Buffer): MinimalAwsClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async send(command: unknown) {
      calls.push(command);
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array(envelope) } };
      }
      throw new Error(`Unexpected S3 command in test: ${command?.constructor?.name}`);
    },
  };
}

function makeKmsClient(dataKey: Buffer = DATA_KEY): MinimalAwsClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async send(command: unknown) {
      calls.push(command);
      if (command instanceof DecryptCommand) {
        return { Plaintext: new Uint8Array(dataKey) };
      }
      throw new Error(`Unexpected KMS command in test: ${command?.constructor?.name}`);
    },
  };
}

function makeFailingKmsClient(message: string): MinimalAwsClient {
  return {
    async send() {
      throw new Error(message);
    },
  };
}

describe('generateVerificationDatabaseName / assertSafeVerificationDatabaseName', () => {
  it('generates a name with the required prefix', () => {
    const name = generateVerificationDatabaseName();
    expect(name.startsWith(VERIFY_DB_PREFIX)).toBe(true);
  });

  it('generates a unique name on every call', () => {
    const a = generateVerificationDatabaseName();
    const b = generateVerificationDatabaseName();
    expect(a).not.toBe(b);
  });

  it('accepts a well-formed generated name', () => {
    expect(() => assertSafeVerificationDatabaseName(generateVerificationDatabaseName())).not.toThrow();
  });

  it('rejects tms_dev outright', () => {
    expect(() => assertSafeVerificationDatabaseName('tms_dev')).toThrow(/prefix/i);
  });

  it('rejects tms_local_test outright', () => {
    expect(() => assertSafeVerificationDatabaseName('tms_local_test')).toThrow(/prefix/i);
  });

  it('rejects postgres/template0/template1', () => {
    expect(() => assertSafeVerificationDatabaseName('postgres')).toThrow();
    expect(() => assertSafeVerificationDatabaseName('template0')).toThrow();
    expect(() => assertSafeVerificationDatabaseName('template1')).toThrow();
  });

  it('rejects a name with the right prefix but forbidden as a whole', () => {
    // Even a well-prefixed name is still checked against the forbidden list.
    expect(() => assertSafeVerificationDatabaseName(`${VERIFY_DB_PREFIX}tms_dev`)).not.toThrow(); // distinct name, not literally forbidden
    expect(() => assertSafeVerificationDatabaseName('tms_dev', [])).toThrow();
  });

  it('rejects a name missing the required prefix even if otherwise safe-looking', () => {
    expect(() => assertSafeVerificationDatabaseName('some_other_db')).toThrow(/prefix/i);
  });

  it('rejects unsafe characters (SQL injection attempt)', () => {
    expect(() => assertSafeVerificationDatabaseName(`${VERIFY_DB_PREFIX}x"; DROP TABLE foo; --`)).toThrow(/lowercase letters/i);
  });

  it('rejects a name containing a semicolon', () => {
    expect(() => assertSafeVerificationDatabaseName(`${VERIFY_DB_PREFIX}abc;drop`)).toThrow(/lowercase letters/i);
  });

  it('rejects extra configured forbidden names', () => {
    expect(() => assertSafeVerificationDatabaseName(`${VERIFY_DB_PREFIX}staging`, [`${VERIFY_DB_PREFIX}staging`])).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => assertSafeVerificationDatabaseName('')).toThrow();
  });
});

describe('assertSafeMaintenanceDatabaseName — Task #10C.4A', () => {
  it('accepts postgres/template0/template1 as valid maintenance targets', () => {
    expect(() => assertSafeMaintenanceDatabaseName('postgres')).not.toThrow();
    expect(() => assertSafeMaintenanceDatabaseName('template0')).not.toThrow();
    expect(() => assertSafeMaintenanceDatabaseName('template1')).not.toThrow();
  });

  it('rejects tms_dev as a maintenance connection target', () => {
    expect(() => assertSafeMaintenanceDatabaseName('tms_dev')).toThrow(/maintenance/i);
  });

  it('rejects tms_local_test as a maintenance connection target', () => {
    expect(() => assertSafeMaintenanceDatabaseName('tms_local_test')).toThrow(/maintenance/i);
  });

  it('rejects any additionally configured forbidden production database name', () => {
    expect(() => assertSafeMaintenanceDatabaseName('tms_staging', ['tms_staging'])).toThrow(/maintenance/i);
  });
});

describe('quotePostgresIdentifier', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quotePostgresIdentifier('tms_restore_verify_x')).toBe('"tms_restore_verify_x"');
  });

  it('doubles an embedded double-quote character', () => {
    expect(quotePostgresIdentifier('weird"name')).toBe('"weird""name"');
  });
});

describe('resolveRestoreVerifyConfig', () => {
  const VALID_ENV: NodeJS.ProcessEnv = {
    RESTORE_VERIFY_S3_ACCESS_KEY_ID: 'fake-access-key',
    RESTORE_VERIFY_S3_SECRET_ACCESS_KEY: 'fake-secret',
    RESTORE_VERIFY_S3_BUCKET: 'tms-db-backups-prod-2026',
    RESTORE_VERIFY_S3_REGION: 'us-east-1',
    RESTORE_VERIFY_S3_KEY: 'daily/tms_dev-20260906-000000Z.dump.enc',
    RESTORE_VERIFY_KMS_KEY_ID: 'arn:aws:kms:us-east-1:955075461399:key/test',
    RESTORE_VERIFY_DATABASE_URL: 'postgresql://tms_backup_verify@127.0.0.1:5432/postgres',
  };

  it('resolves successfully with every required variable present', () => {
    const config = resolveRestoreVerifyConfig(VALID_ENV);
    expect(config.source.bucket).toBe(VALID_ENV.RESTORE_VERIFY_S3_BUCKET);
    expect(config.source.key).toBe(VALID_ENV.RESTORE_VERIFY_S3_KEY);
    expect(config.maintenanceDatabaseUrl).toBe(VALID_ENV.RESTORE_VERIFY_DATABASE_URL);
  });

  it('throws listing every missing variable', () => {
    expect(() => resolveRestoreVerifyConfig({})).toThrow(
      /RESTORE_VERIFY_S3_ACCESS_KEY_ID.*RESTORE_VERIFY_S3_SECRET_ACCESS_KEY.*RESTORE_VERIFY_S3_BUCKET.*RESTORE_VERIFY_S3_REGION.*RESTORE_VERIFY_S3_KEY.*RESTORE_VERIFY_KMS_KEY_ID.*RESTORE_VERIFY_DATABASE_URL/s,
    );
  });

  it('never falls back to BACKUP_S3_* or BACKUP_DATABASE_URL', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      BACKUP_S3_ACCESS_KEY_ID: 'uploader-key-must-not-be-used',
      BACKUP_DATABASE_URL: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_dev',
    };
    delete env.RESTORE_VERIFY_S3_ACCESS_KEY_ID;
    expect(() => resolveRestoreVerifyConfig(env)).toThrow(/RESTORE_VERIFY_S3_ACCESS_KEY_ID/);
  });
});

describe('resolveRestoreVerifyConfigForKey — Task #10C.6C production orchestration variant', () => {
  const VALID_ENV_WITHOUT_KEY: NodeJS.ProcessEnv = {
    RESTORE_VERIFY_S3_ACCESS_KEY_ID: 'fake-access-key',
    RESTORE_VERIFY_S3_SECRET_ACCESS_KEY: 'fake-secret',
    RESTORE_VERIFY_S3_BUCKET: 'tms-db-backups-prod-2026',
    RESTORE_VERIFY_S3_REGION: 'us-east-1',
    RESTORE_VERIFY_KMS_KEY_ID: 'arn:aws:kms:us-east-1:955075461399:key/test',
    RESTORE_VERIFY_DATABASE_URL: 'postgresql://tms_backup_verify@127.0.0.1:5432/postgres',
  };
  const EXACT_KEY = 'daily/tms_dev-20260907-020000Z.dump.enc';

  it('resolves successfully using the supplied key, without requiring RESTORE_VERIFY_S3_KEY in the env', () => {
    const config = resolveRestoreVerifyConfigForKey(VALID_ENV_WITHOUT_KEY, EXACT_KEY);
    expect(config.source.key).toBe(EXACT_KEY);
    expect(config.source.bucket).toBe(VALID_ENV_WITHOUT_KEY.RESTORE_VERIFY_S3_BUCKET);
    expect(config.maintenanceDatabaseUrl).toBe(VALID_ENV_WITHOUT_KEY.RESTORE_VERIFY_DATABASE_URL);
  });

  it('ignores a stale/operator-configured RESTORE_VERIFY_S3_KEY in favor of the supplied key', () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ENV_WITHOUT_KEY, RESTORE_VERIFY_S3_KEY: 'stale/should-not-be-used.dump.enc' };
    const config = resolveRestoreVerifyConfigForKey(env, EXACT_KEY);
    expect(config.source.key).toBe(EXACT_KEY);
  });

  it('throws when no key is supplied', () => {
    expect(() => resolveRestoreVerifyConfigForKey(VALID_ENV_WITHOUT_KEY, '')).toThrow(
      /no S3 object key was supplied/,
    );
  });

  it('throws listing missing variables, but never lists RESTORE_VERIFY_S3_KEY as required', () => {
    expect(() => resolveRestoreVerifyConfigForKey({}, EXACT_KEY)).toThrow(
      /RESTORE_VERIFY_S3_ACCESS_KEY_ID.*RESTORE_VERIFY_S3_SECRET_ACCESS_KEY.*RESTORE_VERIFY_S3_BUCKET.*RESTORE_VERIFY_S3_REGION.*RESTORE_VERIFY_KMS_KEY_ID.*RESTORE_VERIFY_DATABASE_URL/s,
    );
    expect(() => resolveRestoreVerifyConfigForKey({}, EXACT_KEY)).not.toThrow(/RESTORE_VERIFY_S3_KEY/);
  });

  it('never falls back to BACKUP_S3_* or BACKUP_DATABASE_URL', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV_WITHOUT_KEY,
      BACKUP_S3_ACCESS_KEY_ID: 'uploader-key-must-not-be-used',
      BACKUP_DATABASE_URL: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_dev',
    };
    delete env.RESTORE_VERIFY_S3_ACCESS_KEY_ID;
    expect(() => resolveRestoreVerifyConfigForKey(env, EXACT_KEY)).toThrow(/RESTORE_VERIFY_S3_ACCESS_KEY_ID/);
  });
});

describe('runSanityChecks', () => {
  afterEach(() => mockSpawnSync.mockReset());

  it('passes when structural checks and representative tables all look healthy', () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const result = runSanityChecks(FAKE_PSQL, {}, 'tms_restore_verify_x');
    expect(result.passed).toBe(true);
  });

  it('fails when the table count is below the structural floor', () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 2, rowCounts: { organization: 3, user: 12 } }));
    const result = runSanityChecks(FAKE_PSQL, {}, 'tms_restore_verify_x');
    expect(result.passed).toBe(false);
  });

  it('fails when a representative table is empty', () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 0, user: 12 } }));
    const result = runSanityChecks(FAKE_PSQL, {}, 'tms_restore_verify_x');
    expect(result.passed).toBe(false);
  });

  it('fails when a required table (checked by name, not just count) is missing from the restore', () => {
    mockSpawnSync.mockImplementation(
      makeSpawnSyncRouter({
        tableCount: 43, // count alone still looks healthy...
        rowCounts: { organization: 3, user: 12 },
        missingRequiredTables: ['load'], // ...but a specific critical table is gone
      }),
    );
    const result = runSanityChecks(FAKE_PSQL, {}, 'tms_restore_verify_x');
    expect(result.passed).toBe(false);
    expect(result.details.some((d) => d.includes('load'))).toBe(true);
  });

  it('fails if current_database() does not match the expected verification database', () => {
    mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argv = args ?? [];
      const cIndex = argv.indexOf('-c');
      const sql = cIndex >= 0 ? argv[cIndex + 1] : '';
      if (sql.includes('current_database')) {
        return { status: 0, stdout: buf('some_other_database'), stderr: buf('') };
      }
      return { status: 0, stdout: buf('20'), stderr: buf('') };
    });
    const result = runSanityChecks(FAKE_PSQL, {}, 'tms_restore_verify_x');
    expect(result.passed).toBe(false);
  });
});

describe('verificationDatabaseExists — Task #10C.4B regression coverage', () => {
  afterEach(() => mockSpawnSync.mockReset());

  it('returns false for a fresh, valid generated database name that does not yet exist', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ existsQueryStdout: '' }));
    const name = generateVerificationDatabaseName();

    const exists = await verificationDatabaseExists(FAKE_PSQL, {}, 'postgres', name);

    expect(exists).toBe(false);
  });

  it('returns true when the query reports the name already exists', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ existsQueryStdout: '1' }));
    const name = generateVerificationDatabaseName();

    const exists = await verificationDatabaseExists(FAKE_PSQL, {}, 'postgres', name);

    expect(exists).toBe(true);
  });

  it('rejects an unsafe database name before ever calling psql (defensive re-validation)', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter());

    await expect(verificationDatabaseExists(FAKE_PSQL, {}, 'postgres', 'tms_dev')).rejects.toThrow();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('rejects a name containing SQL metacharacters before ever calling psql', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter());

    await expect(
      verificationDatabaseExists(FAKE_PSQL, {}, 'postgres', `${VERIFY_DB_PREFIX}x'; DROP TABLE foo; --`),
    ).rejects.toThrow();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('regression: never sends the broken psql :\'var\' interpolation syntax, and embeds a safe quoted literal instead', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ existsQueryStdout: '' }));
    const name = generateVerificationDatabaseName();

    await verificationDatabaseExists(FAKE_PSQL, {}, 'postgres', name);

    const call = mockSpawnSync.mock.calls.find(([cmd]) => cmd === FAKE_PSQL);
    const args = (call?.[1] ?? []) as string[];
    const cIndex = args.indexOf('-c');
    const sql = args[cIndex + 1];

    expect(sql).not.toMatch(/:'/); // the confirmed-broken syntax must never appear again
    expect(sql).toContain(`'${name}'`); // the value is embedded directly as a safe literal
  });
});

describe('runRestoreVerification — full pipeline with mocked KMS/S3/psql/pg_restore', () => {
  let workDir: string;
  let baseConfig: RestoreVerifyConfig;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tms-restore-verify-test-'));
    baseConfig = {
      source: {
        bucket: 'tms-db-backups-prod-2026',
        key: 'daily/tms_dev-20260906-000000Z.dump.enc',
        region: 'us-east-1',
        accessKeyId: 'fake-restorer-access-key',
        secretAccessKey: 'fake-restorer-secret',
        kmsKeyId: 'test-kms-key',
      },
      maintenanceDatabaseUrl: 'postgresql://tms_backup_verify@127.0.0.1:5432/postgres',
      psqlPath: FAKE_PSQL,
      pgRestorePath: FAKE_PG_RESTORE,
      workDir,
      forbiddenDatabaseNames: [],
    };
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('succeeds end to end: download, decrypt, create, restore, sanity-check, drop', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).toBe(0);
    // DROP DATABASE must have been called.
    const dropCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => {
      const cIndex = (args ?? []).indexOf('-c');
      return cmd === FAKE_PSQL && cIndex >= 0 && (args as string[])[cIndex + 1]?.startsWith('DROP DATABASE');
    });
    expect(dropCalls.length).toBe(1);
  });

  it('rejects a corrupted envelope before any database operation is attempted', async () => {
    const corrupted = buildFixtureEnvelope();
    corrupted[corrupted.length - 1] ^= 0xff; // flip a ciphertext byte -> auth failure later, or corrupt structurally
    const s3Client = makeS3Client(corrupted);
    const kmsClient = makeKmsClient();
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter());

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    const createCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => {
      const cIndex = (args ?? []).indexOf('-c');
      return cmd === FAKE_PSQL && cIndex >= 0 && (args as string[])[cIndex + 1]?.startsWith('CREATE DATABASE');
    });
    expect(createCalls.length).toBe(0); // never reached CREATE DATABASE
  });

  it('rejects when KMS Decrypt fails (e.g. wrong/inaccessible key) — never reaches database operations', async () => {
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeFailingKmsClient('AccessDeniedException: The ciphertext refers to a customer master key that does not exist');
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter());

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('cleans up after a CREATE DATABASE failure (no restore/drop attempted, plaintext removed)', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ createDatabase: { errorMessage: 'ENOENT' } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    const pgRestoreCalls = mockSpawnSync.mock.calls.filter(([cmd]) => cmd === FAKE_PG_RESTORE);
    expect(pgRestoreCalls.length).toBe(0);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.dump'))).toHaveLength(0);
  });

  it('cleans up after a pg_restore failure: DROP DATABASE is still attempted, plaintext removed', async () => {
    mockSpawnSync.mockImplementation(
      makeSpawnSyncRouter({ pgRestore: { status: 1, stderr: 'pg_restore: error: could not execute query' } }),
    );
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    const dropCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => {
      const cIndex = (args ?? []).indexOf('-c');
      return cmd === FAKE_PSQL && cIndex >= 0 && (args as string[])[cIndex + 1]?.startsWith('DROP DATABASE');
    });
    expect(dropCalls.length).toBe(1);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.dump'))).toHaveLength(0);
  });

  it('fails the overall run when sanity checks fail, and still drops the disposable database', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 0, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    const dropCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => {
      const cIndex = (args ?? []).indexOf('-c');
      return cmd === FAKE_PSQL && cIndex >= 0 && (args as string[])[cIndex + 1]?.startsWith('DROP DATABASE');
    });
    expect(dropCalls.length).toBe(1);
  });

  it('treats an otherwise-successful run as FAILED if DROP DATABASE itself fails (loud failure, not silent success)', async () => {
    mockSpawnSync.mockImplementation(
      makeSpawnSyncRouter({
        tableCount: 43,
        rowCounts: { organization: 3, user: 12 },
        dropDatabase: { errorMessage: 'connection refused' },
      }),
    );
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0); // the restore itself succeeded, but a failed cleanup must still fail the run
  });

  it('refuses to proceed (fails closed) if the generated verification database name already exists', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ existsQueryStdout: '1' }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    const createCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => {
      const cIndex = (args ?? []).indexOf('-c');
      return cmd === FAKE_PSQL && cIndex >= 0 && (args as string[])[cIndex + 1]?.startsWith('CREATE DATABASE');
    });
    expect(createCalls.length).toBe(0); // never created a DB with a name that might already be in use
  });

  it('never issues an S3 delete or put — only GetObject', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(s3Client.calls.some((c) => c instanceof DeleteObjectCommand)).toBe(false);
    expect(s3Client.calls.some((c) => c instanceof PutObjectCommand)).toBe(false);
    expect(s3Client.calls.every((c) => c instanceof GetObjectCommand)).toBe(true);
  });

  it('leaves no plaintext .dump file behind after a successful run', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(existsSync(workDir)).toBe(true);
    expect(readdirSync(workDir).filter((f) => f.endsWith('.dump'))).toHaveLength(0);
  });

  it('never logs the plaintext data key or the restorer secret access key', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runRestoreVerification(baseConfig, { s3Client, kmsClient });
      const allLogged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(allLogged).not.toContain(DATA_KEY.toString('base64'));
      expect(allLogged).not.toContain(DATA_KEY.toString('hex'));
      expect(allLogged).not.toContain(baseConfig.source.secretAccessKey);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('refuses to run when RESTORE_VERIFY_DATABASE_URL itself points at tms_dev (Task #10C.4A)', async () => {
    const unsafeConfig: RestoreVerifyConfig = {
      ...baseConfig,
      maintenanceDatabaseUrl: 'postgresql://tms_backup_verify@127.0.0.1:5432/tms_dev',
    };
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(unsafeConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled(); // rejected before any AWS or psql call
    expect(s3Client.calls).toHaveLength(0);
  });

  it('refuses to run when RESTORE_VERIFY_DATABASE_URL points at tms_local_test', async () => {
    const unsafeConfig: RestoreVerifyConfig = {
      ...baseConfig,
      maintenanceDatabaseUrl: 'postgresql://tms_backup_verify@127.0.0.1:5432/tms_local_test',
    };
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(unsafeConfig, { s3Client, kmsClient });

    expect(exitCode).not.toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('invokes pg_restore with --single-transaction so a partial restore cannot succeed silently', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    const pgRestoreCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === FAKE_PG_RESTORE);
    expect(pgRestoreCall?.[1]).toContain('--single-transaction');
  });

  it('regression (Task #10C.4C): pg_restore receives an explicit -d <disposable database name>, never --clean, and never the maintenance database', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    const pgRestoreCall = mockSpawnSync.mock.calls.find(([cmd]) => cmd === FAKE_PG_RESTORE);
    const args = (pgRestoreCall?.[1] ?? []) as string[];

    // pg_restore does not fall back to PGDATABASE — confirmed by a real
    // end-to-end failure ("one of -d/--dbname and -f/--file must be
    // specified") — so -d must be passed explicitly.
    const dIndex = args.indexOf('-d');
    expect(dIndex).toBeGreaterThanOrEqual(0);

    const targetDb = args[dIndex + 1];
    expect(targetDb).toMatch(new RegExp(`^${VERIFY_DB_PREFIX}`));
    expect(targetDb).not.toBe('postgres'); // never the maintenance database
    expect(targetDb).not.toBe(baseConfig.maintenanceDatabaseUrl);

    // Extracted from the actual generated-name log line so this test
    // doesn't hardcode a name generateVerificationDatabaseName() produced.
    const generatedNameLine = mockSpawnSync.mock.calls
      .map(([, a]) => a as string[])
      .flat()
      .find((v) => typeof v === 'string' && v.startsWith('CREATE DATABASE'));
    const createdName = generatedNameLine?.match(/"([^"]+)"/)?.[1];
    expect(targetDb).toBe(createdName); // the exact same disposable name CREATE DATABASE used

    expect(args).toContain('--single-transaction');
    expect(args).toContain('--no-owner');
    expect(args).toContain('--no-privileges');
    expect(args).not.toContain('--clean');
  });

  it('recovers from a transient DROP DATABASE failure via retry, and still reports success', async () => {
    let dropAttempts = 0;
    mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argv = args ?? [];
      const cIndex = argv.indexOf('-c');
      const sql = cIndex >= 0 ? argv[cIndex + 1] : '';
      if (cmd === FAKE_PSQL && sql.startsWith('DROP DATABASE')) {
        dropAttempts += 1;
        if (dropAttempts < 2) {
          return { status: 1, stdout: buf(''), stderr: buf('database is being accessed by other users') };
        }
        return { status: 0, stdout: buf(''), stderr: buf('') };
      }
      return makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } })(cmd, args);
    });
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });

    expect(exitCode).toBe(0);
    expect(dropAttempts).toBe(2);
  }, 15000);

  it('fails the overall run if the temporary plaintext dump cannot be removed', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    const s3Client = makeS3Client(buildFixtureEnvelope());
    const kmsClient = makeKmsClient();

    const fsModule = require('node:fs');
    const unlinkSpy = jest.spyOn(fsModule, 'unlinkSync').mockImplementation(() => {
      throw new Error('EPERM: file is locked');
    });

    try {
      const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });
      expect(exitCode).not.toBe(0);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('a second concurrent invocation targeting the same work directory is rejected by the lock', async () => {
    mockSpawnSync.mockImplementation(makeSpawnSyncRouter({ tableCount: 43, rowCounts: { organization: 3, user: 12 } }));
    // Simulate an in-progress run by pre-creating the lock file this module uses.
    const { acquireBackupLock } = require('./backup-lock');
    const lock = acquireBackupLock(join(workDir, '.restore-verify.lock'));

    try {
      const s3Client = makeS3Client(buildFixtureEnvelope());
      const kmsClient = makeKmsClient();
      const exitCode = await runRestoreVerification(baseConfig, { s3Client, kmsClient });
      expect(exitCode).not.toBe(0);
      expect(mockSpawnSync).not.toHaveBeenCalled(); // never got past lock acquisition
    } finally {
      lock.release();
    }
  });
});
