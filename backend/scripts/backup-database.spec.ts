import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildS3ObjectKey,
  databaseNameFromUrl,
  encryptAndUploadDump,
  normalizeS3Prefix,
  resolveBackupConfig,
  runBackup,
  type BackupConfig,
  type BackupS3Config,
  type MinimalAwsClient,
} from './backup-database';
import { parseEnvelope, decryptEnvelope } from './backup-envelope';

/**
 * Task #10C.2 — tests the orchestration in backup-database.ts with
 * injected KMS/S3 stubs. Deliberately does NOT invoke pg_dump or any
 * real database: encryptAndUploadDump operates on an already-produced
 * plaintext fixture file, so these tests never need Postgres, AWS
 * credentials, or a network connection.
 */

const VALID_ENV: NodeJS.ProcessEnv = {
  BACKUP_DATABASE_URL: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_local_test',
  BACKUP_S3_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  BACKUP_S3_SECRET_ACCESS_KEY: 'fake-secret-value-not-real',
  BACKUP_S3_BUCKET: 'tms-db-backups-prod-2026',
  BACKUP_S3_REGION: 'us-east-1',
  BACKUP_KMS_KEY_ID: 'arn:aws:kms:us-east-1:955075461399:key/2fa9912f-1f3b-4fbb-8db0-c1660b0b68db',
};

const FAKE_S3: BackupS3Config = {
  accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'fake-secret-value-not-real',
  bucket: 'tms-db-backups-local-test',
  region: 'us-east-1',
  prefix: 'daily',
};

function makeStubKmsClient(plaintextKey: Buffer): MinimalAwsClient {
  return {
    async send() {
      return { Plaintext: plaintextKey, CiphertextBlob: Buffer.from('fake-encrypted-data-key') };
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

function makeCapturingS3Client(): MinimalAwsClient & {
  uploadedBody?: Buffer;
  uploadedKey?: string;
  uploadedIfNoneMatch?: string;
} {
  const client = {
    uploadedBody: undefined as Buffer | undefined,
    uploadedKey: undefined as string | undefined,
    uploadedIfNoneMatch: undefined as string | undefined,
    async send(command: unknown) {
      const input = (command as { input?: { Body?: Buffer; Key?: string; IfNoneMatch?: string } }).input;
      client.uploadedBody = input?.Body;
      client.uploadedKey = input?.Key;
      client.uploadedIfNoneMatch = input?.IfNoneMatch;
      return { $metadata: { httpStatusCode: 200 } };
    },
  };
  return client;
}

function makeFailingS3Client(message: string): MinimalAwsClient {
  return {
    async send() {
      throw new Error(message);
    },
  };
}

describe('resolveBackupConfig — required backup-destination configuration', () => {
  it('resolves successfully when every required variable is present', () => {
    const config = resolveBackupConfig(VALID_ENV);
    expect(config.kmsKeyId).toBe(VALID_ENV.BACKUP_KMS_KEY_ID);
    expect(config.s3.bucket).toBe(VALID_ENV.BACKUP_S3_BUCKET);
  });

  it('throws when BACKUP_DATABASE_URL is missing, before checking anything else', () => {
    const env = { ...VALID_ENV };
    delete env.BACKUP_DATABASE_URL;
    expect(() => resolveBackupConfig(env)).toThrow(/BACKUP_DATABASE_URL/);
  });

  it('throws listing every missing backup-destination variable, not just the first', () => {
    const env = { BACKUP_DATABASE_URL: VALID_ENV.BACKUP_DATABASE_URL };
    expect(() => resolveBackupConfig(env)).toThrow(
      /BACKUP_S3_ACCESS_KEY_ID.*BACKUP_S3_SECRET_ACCESS_KEY.*BACKUP_S3_BUCKET.*BACKUP_S3_REGION.*BACKUP_KMS_KEY_ID/s,
    );
  });

  it('never falls back to a plain DATABASE_URL or the application S3_* variables', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ENV,
      DATABASE_URL: 'postgresql://tms:pw@127.0.0.1:5432/tms_dev',
      S3_ACCESS_KEY_ID: 'application-document-bucket-key',
      S3_BUCKET: 'tms-documents-prod-2026',
    };
    delete env.BACKUP_S3_ACCESS_KEY_ID;
    expect(() => resolveBackupConfig(env)).toThrow(/BACKUP_S3_ACCESS_KEY_ID/);
  });

  it('defaults s3.prefix to "daily" when BACKUP_S3_PREFIX is not set (production behavior unchanged)', () => {
    const env = { ...VALID_ENV };
    delete env.BACKUP_S3_PREFIX;
    expect(resolveBackupConfig(env).s3.prefix).toBe('daily');
  });

  it('uses an explicit BACKUP_S3_PREFIX when provided', () => {
    const config = resolveBackupConfig({ ...VALID_ENV, BACKUP_S3_PREFIX: 'test' });
    expect(config.s3.prefix).toBe('test');
  });

  it('rejects an invalid BACKUP_S3_PREFIX with a clear configuration error', () => {
    expect(() => resolveBackupConfig({ ...VALID_ENV, BACKUP_S3_PREFIX: '../etc' })).toThrow(
      /BACKUP_S3_PREFIX/,
    );
  });
});

describe('buildS3ObjectKey — naming convention', () => {
  it('builds daily/<db>-YYYYMMDD-HHMMSSZ.dump.enc in UTC for the production prefix', () => {
    const fixedDate = new Date('2026-09-06T20:05:07.123Z');
    expect(buildS3ObjectKey('tms_dev', 'daily', fixedDate)).toBe('daily/tms_dev-20260906-200507Z.dump.enc');
  });

  it('builds test/<db>-YYYYMMDD-HHMMSSZ.dump.enc for an explicit "test" prefix, naming otherwise unchanged', () => {
    const fixedDate = new Date('2026-09-06T20:05:07.123Z');
    expect(buildS3ObjectKey('tms_local_test', 'test', fixedDate)).toBe(
      'test/tms_local_test-20260906-200507Z.dump.enc',
    );
  });

  it('never overwrites — two calls a second apart produce different keys', () => {
    const a = buildS3ObjectKey('tms_dev', 'daily', new Date('2026-09-06T20:05:07.000Z'));
    const b = buildS3ObjectKey('tms_dev', 'daily', new Date('2026-09-06T20:05:08.000Z'));
    expect(a).not.toBe(b);
  });
});

describe('databaseNameFromUrl — Task #10C.6C (exported for the production guard)', () => {
  it('extracts the database name from the connection URL path', () => {
    expect(databaseNameFromUrl('postgresql://tms_backup_dump@127.0.0.1:5432/tms_dev')).toBe('tms_dev');
  });

  it('extracts tms_local_test the same way', () => {
    expect(databaseNameFromUrl('postgresql://tms_backup_dump@127.0.0.1:5432/tms_local_test')).toBe('tms_local_test');
  });
});

describe('normalizeS3Prefix — Task #10C.3.1', () => {
  it('defaults to "daily" when BACKUP_S3_PREFIX is unset', () => {
    expect(normalizeS3Prefix(undefined)).toBe('daily');
  });

  it('accepts an explicit "test" prefix unchanged', () => {
    expect(normalizeS3Prefix('test')).toBe('test');
  });

  it('strips leading and trailing slashes', () => {
    expect(normalizeS3Prefix('/test/')).toBe('test');
    expect(normalizeS3Prefix('//daily//')).toBe('daily');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeS3Prefix('  test  ')).toBe('test');
  });

  it('accepts a multi-segment prefix', () => {
    expect(normalizeS3Prefix('integration-test/run-42')).toBe('integration-test/run-42');
  });

  it('rejects an explicitly-set value that is empty after normalization', () => {
    expect(() => normalizeS3Prefix('')).toThrow(/empty/i);
    expect(() => normalizeS3Prefix('   ')).toThrow(/empty/i);
    expect(() => normalizeS3Prefix('///')).toThrow(/empty/i);
  });

  it('rejects path traversal ("..")', () => {
    expect(() => normalizeS3Prefix('../daily')).toThrow(/invalid/i);
    expect(() => normalizeS3Prefix('daily/..')).toThrow(/invalid/i);
  });

  it('rejects a value that looks like a URL or a bucket override', () => {
    expect(() => normalizeS3Prefix('s3://some-other-bucket/daily')).toThrow(/invalid/i);
    expect(() => normalizeS3Prefix('https://evil.example.com')).toThrow(/invalid/i);
  });

  it('rejects a Windows-style absolute path', () => {
    expect(() => normalizeS3Prefix('C:\\Windows\\System32')).toThrow(/invalid/i);
  });

  it('rejects whitespace inside the prefix', () => {
    expect(() => normalizeS3Prefix('daily backup')).toThrow(/invalid/i);
  });

  it('rejects an empty segment in the middle of a multi-segment prefix', () => {
    expect(() => normalizeS3Prefix('daily//nested')).toThrow(/invalid/i);
  });
});

describe('encryptAndUploadDump — orchestration with injected KMS/S3 stubs', () => {
  let tmpDir: string;
  let plaintextPath: string;
  const plaintext = Buffer.from('PGDMP-fake-pg-dump-custom-format-bytes-for-testing-only');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-backup-test-'));
    plaintextPath = join(tmpDir, 'tms_local_test_fixture.dump');
    writeFileSync(plaintextPath, plaintext);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('succeeds end to end: encrypts, uploads, and decrypts back to the original bytes', async () => {
    const dataKey = Buffer.alloc(32, 7);
    const s3Client = makeCapturingS3Client();

    const exitCode = await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'test-key-id',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(dataKey), s3Client },
    });

    expect(exitCode).toBe(0);
    expect(s3Client.uploadedKey).toMatch(/^daily\/tms_local_test-\d{8}-\d{6}Z\.dump\.enc$/);
    // Task #10C.2.1 — the conditional-write guard must be present on
    // every upload, making a same-key overwrite a hard S3-enforced
    // impossibility rather than a probabilistic one.
    expect(s3Client.uploadedIfNoneMatch).toBe('*');

    const { header, ciphertext } = parseEnvelope(s3Client.uploadedBody!);
    const decrypted = decryptEnvelope(header, ciphertext, dataKey);
    expect(decrypted).toEqual(plaintext);
  });

  it('Task #10C.6C — invokes onUploadSuccess exactly once, with the exact key/bucket, only after a successful upload', async () => {
    const s3Client = makeCapturingS3Client();
    const onUploadSuccess = jest.fn();

    const exitCode = await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'test-key-id',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(Buffer.alloc(32, 3)), s3Client, onUploadSuccess },
    });

    expect(exitCode).toBe(0);
    expect(onUploadSuccess).toHaveBeenCalledTimes(1);
    expect(onUploadSuccess).toHaveBeenCalledWith({ s3Key: s3Client.uploadedKey, bucket: FAKE_S3.bucket });
  });

  it('Task #10C.6C — never invokes onUploadSuccess when the S3 upload fails', async () => {
    const onUploadSuccess = jest.fn();

    const exitCode = await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'test-key-id',
      s3: FAKE_S3,
      deps: {
        kmsClient: makeStubKmsClient(Buffer.alloc(32, 3)),
        s3Client: makeFailingS3Client('simulated S3 outage'),
        onUploadSuccess,
      },
    });

    expect(exitCode).not.toBe(0);
    expect(onUploadSuccess).not.toHaveBeenCalled();
  });

  it('no plaintext dump remains on disk after a successful run', async () => {
    const s3Client = makeCapturingS3Client();
    await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(Buffer.alloc(32, 1)), s3Client },
    });

    expect(existsSync(plaintextPath)).toBe(false);
  });

  it('no local encrypted file remains on disk after a successful upload', async () => {
    const s3Client = makeCapturingS3Client();
    await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(Buffer.alloc(32, 1)), s3Client },
    });

    expect(existsSync(`${plaintextPath}.enc`)).toBe(false);
  });

  it('does not write the plaintext data key to disk anywhere', async () => {
    const dataKey = Buffer.alloc(32, 0xab);
    const s3Client = makeCapturingS3Client();
    await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(dataKey), s3Client },
    });

    // Only the plaintext dump could have existed alongside the key; it's
    // gone, and no other file was ever created in this fixture directory.
    const remainingFiles = readdirSync(tmpDir);
    expect(remainingFiles).toHaveLength(0);
    // Belt-and-suspenders: the uploaded (encrypted) body itself must not
    // contain the raw data key bytes anywhere in it.
    expect(s3Client.uploadedBody!.includes(dataKey)).toBe(false);
  });

  it('handles a KMS GenerateDataKey failure safely: cleans up the plaintext dump, never uploads', async () => {
    const s3Client = makeCapturingS3Client();
    const exitCode = await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeFailingKmsClient('KMS is unreachable'), s3Client },
    });

    expect(exitCode).not.toBe(0);
    expect(existsSync(plaintextPath)).toBe(false); // cleaned up
    expect(existsSync(`${plaintextPath}.enc`)).toBe(false); // never created
    expect(s3Client.uploadedBody).toBeUndefined(); // upload never attempted
  });

  it('an S3 upload failure does not delete the only remaining backup artifact', async () => {
    const dataKey = Buffer.alloc(32, 2);
    const exitCode = await encryptAndUploadDump({
      plaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(dataKey), s3Client: makeFailingS3Client('network error') },
    });

    expect(exitCode).not.toBe(0);
    // The plaintext was already deleted (encryption succeeded)...
    expect(existsSync(plaintextPath)).toBe(false);
    // ...but the encrypted file must survive a failed upload — it is the
    // only remaining copy of this backup, and a failed run must never
    // lose it.
    expect(existsSync(`${plaintextPath}.enc`)).toBe(true);
    const survivingEnvelope = readFileSync(`${plaintextPath}.enc`);
    const { header, ciphertext } = parseEnvelope(survivingEnvelope);
    expect(decryptEnvelope(header, ciphertext, dataKey)).toEqual(plaintext);
  });

  it('never logs the plaintext data key or the S3 secret access key', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const dataKey = Buffer.alloc(32, 9);

    try {
      await encryptAndUploadDump({
        plaintextPath,
        dbName: 'tms_local_test',
        kmsKeyId: 'key',
        s3: FAKE_S3,
        deps: {
          kmsClient: makeStubKmsClient(dataKey),
          s3Client: makeFailingS3Client('simulated failure to also exercise the error log path'),
        },
      });

      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(allLoggedText).not.toContain(dataKey.toString('base64'));
      expect(allLoggedText).not.toContain(dataKey.toString('hex'));
      expect(allLoggedText).not.toContain(FAKE_S3.secretAccessKey);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('encryptAndUploadDump — zero-byte plaintext defense (Task #10C.2.1)', () => {
  let tmpDir: string;
  let emptyPlaintextPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-backup-zerolen-test-'));
    emptyPlaintextPath = join(tmpDir, 'tms_local_test_empty.dump');
    writeFileSync(emptyPlaintextPath, Buffer.alloc(0));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a zero-byte plaintext dump before calling KMS or S3', async () => {
    let kmsCalled = false;
    let s3Called = false;
    const kmsClient: MinimalAwsClient = {
      async send() {
        kmsCalled = true;
        return { Plaintext: Buffer.alloc(32), CiphertextBlob: Buffer.from('blob') };
      },
    };
    const s3Client: MinimalAwsClient = {
      async send() {
        s3Called = true;
        return { $metadata: { httpStatusCode: 200 } };
      },
    };

    const exitCode = await encryptAndUploadDump({
      plaintextPath: emptyPlaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient, s3Client },
    });

    expect(exitCode).not.toBe(0);
    expect(kmsCalled).toBe(false);
    expect(s3Called).toBe(false);
  });

  it('cleans up the empty plaintext file rather than leaving it behind', async () => {
    await encryptAndUploadDump({
      plaintextPath: emptyPlaintextPath,
      dbName: 'tms_local_test',
      kmsKeyId: 'key',
      s3: FAKE_S3,
      deps: { kmsClient: makeStubKmsClient(Buffer.alloc(32)), s3Client: makeCapturingS3Client() },
    });

    expect(existsSync(emptyPlaintextPath)).toBe(false);
  });
});

describe('runBackup — concurrency lock wiring (Task #10C.2.1)', () => {
  let tmpDir: string;
  let config: BackupConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tms-backup-lockwire-test-'));
    config = {
      databaseUrl: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_local_test',
      outputDir: tmpDir,
      pgDumpPath: 'this-binary-does-not-exist-anywhere', // fails fast with ENOENT, never touches Postgres
      pgRestorePath: 'this-binary-does-not-exist-anywhere',
      kmsKeyId: 'key',
      s3: FAKE_S3,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a second concurrent invocation fails immediately with a clear error, before pg_dump is attempted', async () => {
    writeFileSync(
      join(tmpDir, '.backup.lock'),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAtUtc: new Date().toISOString() }),
    );

    const exitCode = await runBackup(config);

    expect(exitCode).not.toBe(0);
    // No dump file was ever created — the lock rejected the run before pg_dump ran.
    expect(readdirSync(tmpDir)).toEqual(['.backup.lock']);
  });

  it('the lock is released after a failed run (pg_dump launch failure)', async () => {
    const exitCode = await runBackup(config);

    expect(exitCode).not.toBe(0); // pg_dump could never launch
    expect(existsSync(join(tmpDir, '.backup.lock'))).toBe(false);
  });

  it('a fresh run can acquire the lock immediately after a previous run released it', async () => {
    await runBackup(config); // fails (bogus pg_dump path) and releases its lock
    const exitCode = await runBackup(config); // must not be blocked by a leftover lock
    expect(existsSync(join(tmpDir, '.backup.lock'))).toBe(false);
    expect(exitCode).not.toBe(0); // still fails on pg_dump, but NOT on lock contention
  });
});
