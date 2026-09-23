import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Task #10C.6C — orchestration tests for the production backup+verify
 * sequence. runBackup/runRestoreVerification are mocked (their own
 * pipelines are already covered by backup-database.spec.ts and
 * backup-restore-verify.spec.ts) so these tests exercise ONLY the
 * orchestration's own behavior: the fail-closed production guard,
 * exact S3-key handoff, single shared lock, and failure/ordering
 * semantics. Never touches real AWS or a real "tms_dev" database.
 */
jest.mock('./backup-database', () => {
  const actual = jest.requireActual('./backup-database');
  return { ...actual, runBackup: jest.fn() };
});
jest.mock('./backup-restore-verify', () => {
  const actual = jest.requireActual('./backup-restore-verify');
  return { ...actual, runRestoreVerification: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { runBackup, type BackupConfig, type BackupDependencies } from './backup-database';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { runRestoreVerification, type RestoreVerifyConfig } from './backup-restore-verify';
import { runProductionBackupAndVerify } from './backup-production';
import { acquireBackupLock } from './backup-lock';

const mockRunBackup = runBackup as jest.MockedFunction<typeof runBackup>;
const mockRunRestoreVerification = runRestoreVerification as jest.MockedFunction<typeof runRestoreVerification>;

const FAKE_S3_KEY = 'daily/tms_dev-20260906-020000Z.dump.enc';

let outputDir: string;

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BACKUP_DATABASE_URL: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_dev',
    BACKUP_OUTPUT_DIR: outputDir,
    BACKUP_S3_ACCESS_KEY_ID: 'AKIAUPLOADERFAKE',
    BACKUP_S3_SECRET_ACCESS_KEY: 'fake-uploader-secret',
    BACKUP_S3_BUCKET: 'tms-db-backups-prod-2026',
    BACKUP_S3_REGION: 'us-east-1',
    BACKUP_KMS_KEY_ID: 'arn:aws:kms:us-east-1:955075461399:key/2fa9912f-1f3b-4fbb-8db0-c1660b0b68db',
    RESTORE_VERIFY_S3_ACCESS_KEY_ID: 'AKIARESTORERFAKE',
    RESTORE_VERIFY_S3_SECRET_ACCESS_KEY: 'fake-restorer-secret',
    RESTORE_VERIFY_S3_BUCKET: 'tms-db-backups-prod-2026',
    RESTORE_VERIFY_S3_REGION: 'us-east-1',
    RESTORE_VERIFY_KMS_KEY_ID: 'arn:aws:kms:us-east-1:955075461399:key/2fa9912f-1f3b-4fbb-8db0-c1660b0b68db',
    RESTORE_VERIFY_DATABASE_URL: 'postgresql://tms_backup_verify@127.0.0.1:5432/postgres',
    ...overrides,
  };
}

/** Simulates a successful backup by returning 0 and firing onUploadSuccess with FAKE_S3_KEY. */
function mockSuccessfulBackup(): void {
  mockRunBackup.mockImplementation(async (_config: BackupConfig, deps: BackupDependencies = {}) => {
    deps.onUploadSuccess?.({ s3Key: FAKE_S3_KEY, bucket: 'tms-db-backups-prod-2026' });
    return 0;
  });
}

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'backup-production-spec-'));
  mockRunBackup.mockReset();
  mockRunRestoreVerification.mockReset();
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

describe('runProductionBackupAndVerify — fail-closed production target guard', () => {
  it('refuses and never calls runBackup when BACKUP_DATABASE_URL targets tms_local_test', async () => {
    const env = baseEnv({ BACKUP_DATABASE_URL: 'postgresql://tms_backup_dump@127.0.0.1:5432/tms_local_test' });
    const exitCode = await runProductionBackupAndVerify(env);
    expect(exitCode).not.toBe(0);
    expect(mockRunBackup).not.toHaveBeenCalled();
    expect(mockRunRestoreVerification).not.toHaveBeenCalled();
  });

  it('refuses postgres/template0/template1/empty exactly like assertProductionDatabaseTarget', async () => {
    for (const badDb of ['postgres', 'template0', 'template1']) {
      const env = baseEnv({ BACKUP_DATABASE_URL: `postgresql://tms_backup_dump@127.0.0.1:5432/${badDb}` });
      const exitCode = await runProductionBackupAndVerify(env);
      expect(exitCode).not.toBe(0);
    }
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it('proceeds to runBackup when the resolved database is exactly tms_dev', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(0);
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(0);
    expect(mockRunBackup).toHaveBeenCalledTimes(1);
  });
});

describe('runProductionBackupAndVerify — production config never falls back', () => {
  it('does not fall back to a generic DATABASE_URL when BACKUP_DATABASE_URL is missing', async () => {
    const env = baseEnv({ DATABASE_URL: 'postgresql://tms:pw@127.0.0.1:5432/tms_dev' });
    delete env.BACKUP_DATABASE_URL;
    const exitCode = await runProductionBackupAndVerify(env);
    expect(exitCode).not.toBe(0);
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it('fails when RESTORE_VERIFY_* config is missing, without ever using BACKUP_S3_* credentials for it', async () => {
    mockSuccessfulBackup();
    const env = baseEnv();
    delete env.RESTORE_VERIFY_DATABASE_URL;
    const exitCode = await runProductionBackupAndVerify(env);
    expect(exitCode).not.toBe(0);
    expect(mockRunRestoreVerification).not.toHaveBeenCalled();
  });
});

describe('runProductionBackupAndVerify — exact S3 key handoff', () => {
  it('passes the exact key captured from the backup step to restore verification, unmodified', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(0);
    await runProductionBackupAndVerify(baseEnv());
    expect(mockRunRestoreVerification).toHaveBeenCalledTimes(1);
    const [restoreConfig] = mockRunRestoreVerification.mock.calls[0] as [RestoreVerifyConfig, ...unknown[]];
    expect(restoreConfig.source.key).toBe(FAKE_S3_KEY);
  });

  it('fails closed (does not call restore verification) if backup reports success without an uploaded key', async () => {
    mockRunBackup.mockResolvedValue(0); // success, but never fires onUploadSuccess
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).not.toBe(0);
    expect(mockRunRestoreVerification).not.toHaveBeenCalled();
  });
});

describe('runProductionBackupAndVerify — ordering and failure propagation', () => {
  it('does not invoke restore verification when the backup fails', async () => {
    mockRunBackup.mockResolvedValue(1);
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(1);
    expect(mockRunRestoreVerification).not.toHaveBeenCalled();
  });

  it('propagates restore verification failure as the overall result', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(1);
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(1);
  });

  it('returns 0 only when both backup and restore verification succeed', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(0);
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(0);
  });
});

describe('runProductionBackupAndVerify — shared lock', () => {
  const lockPath = (): string => join(outputDir, '.backup-production.lock');

  it('acquires the lock before the backup step and it is still held during restore verification (one shared lock)', async () => {
    let lockHeldDuringBackup = false;
    let lockHeldDuringVerify = false;
    mockRunBackup.mockImplementation(async (_config, deps: BackupDependencies = {}) => {
      lockHeldDuringBackup = existsSync(lockPath());
      deps.onUploadSuccess?.({ s3Key: FAKE_S3_KEY, bucket: 'b' });
      return 0;
    });
    mockRunRestoreVerification.mockImplementation(async () => {
      lockHeldDuringVerify = existsSync(lockPath());
      return 0;
    });

    await runProductionBackupAndVerify(baseEnv());
    expect(lockHeldDuringBackup).toBe(true);
    expect(lockHeldDuringVerify).toBe(true);
  });

  it('releases the lock after a successful run (a subsequent run can acquire it immediately)', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(0);
    await runProductionBackupAndVerify(baseEnv());
    expect(existsSync(lockPath())).toBe(false);
    const handle = acquireBackupLock(lockPath());
    handle.release();
  });

  it('releases the lock when the backup step fails', async () => {
    mockRunBackup.mockResolvedValue(1);
    await runProductionBackupAndVerify(baseEnv());
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when the backup step throws unexpectedly', async () => {
    mockRunBackup.mockRejectedValue(new Error('boom'));
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when restore verification fails', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockResolvedValue(1);
    await runProductionBackupAndVerify(baseEnv());
    expect(existsSync(lockPath())).toBe(false);
  });

  it('releases the lock when restore verification throws unexpectedly', async () => {
    mockSuccessfulBackup();
    mockRunRestoreVerification.mockRejectedValue(new Error('boom'));
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses to start a second run while the lock is already held', async () => {
    const handle = acquireBackupLock(lockPath());
    const exitCode = await runProductionBackupAndVerify(baseEnv());
    expect(exitCode).not.toBe(0);
    expect(mockRunBackup).not.toHaveBeenCalled();
    handle.release();
  });
});
