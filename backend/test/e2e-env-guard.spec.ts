import { buildE2EEnv } from './e2e-env-guard';

/**
 * Task #6 — proves the production-safety guard itself, in complete
 * isolation from any real environment variable, any database, any
 * network. This file is run by its own dedicated Jest config
 * (jest-unit-e2e-safety.json), never by jest-e2e.json or the main
 * unit-test config — see package.json's "test:e2e-safety" script.
 */

const VALID_E2E_ENV: NodeJS.ProcessEnv = {
  E2E_DATABASE_URL: 'postgresql://tms:pw@127.0.0.1:5432/tms_e2e_test?schema=public',
  E2E_REDIS_URL: 'redis://127.0.0.1:6379/1',
  E2E_S3_ENDPOINT: 'http://127.0.0.1:9000',
  E2E_S3_BUCKET: 'tms-documents-e2e-test',
  E2E_S3_ACCESS_KEY_ID: 'S3RVER',
  E2E_S3_SECRET_ACCESS_KEY: 'S3RVER',
};

describe('buildE2EEnv — required variables', () => {
  it('throws when E2E_DATABASE_URL is missing', () => {
    const rest = { ...VALID_E2E_ENV };
    delete rest.E2E_DATABASE_URL;
    expect(() => buildE2EEnv(rest)).toThrow(/E2E_DATABASE_URL/);
  });

  it('throws listing every missing required variable, not just the first', () => {
    expect(() => buildE2EEnv({})).toThrow(
      /E2E_DATABASE_URL.*E2E_REDIS_URL.*E2E_S3_ENDPOINT.*E2E_S3_BUCKET.*E2E_S3_ACCESS_KEY_ID.*E2E_S3_SECRET_ACCESS_KEY/s,
    );
  });
});

describe('buildE2EEnv — production-looking values are rejected', () => {
  it("rejects this repository's actual production database name (tms_dev)", () => {
    const env = {
      ...VALID_E2E_ENV,
      E2E_DATABASE_URL: 'postgresql://tms:pw@127.0.0.1:5432/tms_dev?schema=public',
    };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_DATABASE_URL/);
  });

  it('rejects a database URL containing "prod", even if it also contains a safe marker', () => {
    const env = {
      ...VALID_E2E_ENV,
      E2E_DATABASE_URL: 'postgresql://tms:pw@127.0.0.1:5432/tms_test_prod?schema=public',
    };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_DATABASE_URL/);
  });

  it("rejects this repository's actual production S3 bucket name", () => {
    const env = { ...VALID_E2E_ENV, E2E_S3_BUCKET: 'tms-documents-prod-2026' };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_S3_BUCKET/);
  });

  it('rejects a non-local S3 endpoint (real AWS)', () => {
    const env = { ...VALID_E2E_ENV, E2E_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com' };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_S3_ENDPOINT/);
  });

  it("rejects this repository's actual production Redis default (no DB-index segment)", () => {
    const env = { ...VALID_E2E_ENV, E2E_REDIS_URL: 'redis://127.0.0.1:6379' };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_REDIS_URL/);
  });

  it('rejects the localhost-hostname spelling of the production Redis default too', () => {
    const env = { ...VALID_E2E_ENV, E2E_REDIS_URL: 'redis://localhost:6379' };
    expect(() => buildE2EEnv(env)).toThrow(/E2E_REDIS_URL/);
  });
});

describe('buildE2EEnv — a valid isolated environment is accepted', () => {
  it('returns the mapped values without throwing', () => {
    const result = buildE2EEnv(VALID_E2E_ENV);
    expect(result).toEqual(
      expect.objectContaining({
        DATABASE_URL: VALID_E2E_ENV.E2E_DATABASE_URL,
        REDIS_URL: VALID_E2E_ENV.E2E_REDIS_URL,
        S3_ENDPOINT: VALID_E2E_ENV.E2E_S3_ENDPOINT,
        S3_BUCKET: VALID_E2E_ENV.E2E_S3_BUCKET,
        S3_ACCESS_KEY_ID: VALID_E2E_ENV.E2E_S3_ACCESS_KEY_ID,
        S3_SECRET_ACCESS_KEY: VALID_E2E_ENV.E2E_S3_SECRET_ACCESS_KEY,
      }),
    );
  });

  it('always forces MALWARE_SCAN_ENABLED to false, regardless of input', () => {
    const result = buildE2EEnv(VALID_E2E_ENV);
    expect(result.MALWARE_SCAN_ENABLED).toBe('false');
  });

  it('defaults POSTMARK_API_KEY to an empty string when no E2E_POSTMARK_API_KEY is given', () => {
    const result = buildE2EEnv(VALID_E2E_ENV);
    expect(result.POSTMARK_API_KEY).toBe('');
  });
});

describe('buildE2EEnv — a production DATABASE_URL cannot silently become the E2E target', () => {
  it('ignores a plain (non-E2E_-prefixed) DATABASE_URL entirely, even a production-looking one', () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_E2E_ENV,
      // Simulates this exact machine's real backend/.env value already
      // being present in process.env (e.g. inherited from a parent
      // shell) at the moment buildE2EEnv runs.
      DATABASE_URL: 'postgresql://tms:tms_dev_password@127.0.0.1:5432/tms_dev?schema=public',
      REDIS_URL: 'redis://127.0.0.1:6379',
      S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      S3_BUCKET: 'tms-documents-prod-2026',
    };

    const result = buildE2EEnv(env);

    expect(result.DATABASE_URL).toBe(VALID_E2E_ENV.E2E_DATABASE_URL);
    expect(result.DATABASE_URL).not.toBe(env.DATABASE_URL);
    expect(result.REDIS_URL).not.toBe(env.REDIS_URL);
    expect(result.S3_ENDPOINT).not.toBe(env.S3_ENDPOINT);
    expect(result.S3_BUCKET).not.toBe(env.S3_BUCKET);
  });
});
