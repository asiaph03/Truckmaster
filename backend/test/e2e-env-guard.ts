/**
 * Task #6 — the single source of truth for "is it safe to point the E2E
 * suite at this Postgres/Redis/S3?" Pure function, no side effects (never
 * reads or writes the real `process.env` itself — callers do that), so it
 * can be unit-tested directly (see e2e-env-guard.spec.ts) without ever
 * touching a real environment variable.
 *
 * Used by two call sites that both need the identical guarantee:
 *  - test/setup-e2e-env.ts (Jest setupFiles, before ConfigModule loads
 *    backend/.env — see that file's own doc comment for why order matters)
 *  - scripts/bootstrap-e2e-db.ts (the schema/RLS/seed bootstrap, run
 *    before `prisma migrate deploy` etc.)
 *
 * Design principle: this ONLY ever reads `E2E_`-prefixed input keys. It
 * never reads plain `DATABASE_URL`/`REDIS_URL`/`S3_*` from the source at
 * all — so a production value already sitting in `process.env` (e.g.
 * inherited from a parent shell) can never leak into the returned
 * mapping, regardless of what it contains.
 */

const REQUIRED_KEYS = [
  'E2E_DATABASE_URL',
  'E2E_REDIS_URL',
  'E2E_S3_ENDPOINT',
  'E2E_S3_BUCKET',
  'E2E_S3_ACCESS_KEY_ID',
  'E2E_S3_SECRET_ACCESS_KEY',
] as const;

// Allow-list, not a deny-list: an isolated test resource is expected to
// carry one of these markers. An unrecognized-but-real-looking name
// (e.g. this repo's actual production DB name `tms_dev`, which matches
// none of these) is rejected by default rather than silently accepted.
const SAFE_MARKERS = ['test', 'e2e', 'ci', 'local'];

// Deny-list, independent of the allow-list above — catches this repo's
// actual production S3 bucket name (`tms-documents-prod-2026`) even if a
// future rename happened to also contain one of the SAFE_MARKERS above.
const PRODUCTION_MARKERS = ['prod'];

// This repo's actual, real production Redis value (backend/.env has no
// DB-index path segment at all, i.e. always DB 0). Rejecting exactly
// this — rather than trying to enumerate every possible production
// value — forces every E2E environment to explicitly opt into a
// distinct DB index, which is the one concrete mechanism available to
// keep BullMQ queues (hardcoded, identical literal names in every
// environment) from ever being shared with a live production worker.
const KNOWN_PRODUCTION_REDIS_URLS = ['redis://127.0.0.1:6379', 'redis://localhost:6379'];

export interface E2EEnvMapping {
  DATABASE_URL: string;
  REDIS_URL: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: string;
  MALWARE_SCAN_ENABLED: string;
  POSTMARK_API_KEY: string;
  POSTMARK_FROM_ADDRESS: string;
  SESSION_SECRET: string;
}

function assertLooksLikeTestResource(varName: string, value: string): void {
  const lower = value.toLowerCase();
  if (PRODUCTION_MARKERS.some((marker) => lower.includes(marker))) {
    throw new Error(
      `Refusing to run E2E tests: ${varName} looks production-like (matches a ` +
        `known production marker). Value not printed to avoid leaking it into logs.`,
    );
  }
  if (!SAFE_MARKERS.some((marker) => lower.includes(marker))) {
    throw new Error(
      `Refusing to run E2E tests: ${varName} does not look like an isolated test ` +
        `resource (expected it to contain one of: ${SAFE_MARKERS.join(', ')}). ` +
        `Value not printed to avoid leaking it into logs.`,
    );
  }
}

function assertLocalS3Endpoint(endpoint: string): void {
  const lower = endpoint.toLowerCase();
  if (!lower.includes('127.0.0.1') && !lower.includes('localhost')) {
    throw new Error(
      'Refusing to run E2E tests: E2E_S3_ENDPOINT must be a local address ' +
        '(127.0.0.1/localhost) — E2E must never target a real AWS endpoint, ' +
        'regardless of bucket name. Value not printed to avoid leaking it into logs.',
    );
  }
}

function assertIsolatedRedisUrl(redisUrl: string): void {
  if (KNOWN_PRODUCTION_REDIS_URLS.includes(redisUrl)) {
    throw new Error(
      "Refusing to run E2E tests: E2E_REDIS_URL matches this repository's known " +
        'production default (no DB-index segment). BullMQ queue names are hardcoded ' +
        'literals shared with the live production worker — E2E_REDIS_URL must include ' +
        'an explicit "/<db-index>" path (e.g. "redis://127.0.0.1:6379/1") so E2E jobs ' +
        'can never be dequeued by a live production worker.',
    );
  }
}

export function buildE2EEnv(source: NodeJS.ProcessEnv): E2EEnvMapping {
  const missing = REQUIRED_KEYS.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run E2E tests: required env var(s) not set: ${missing.join(', ')}. ` +
        'The E2E suite must NEVER fall back to backend/.env (which may be a live ' +
        'production configuration) — set every E2E_* variable explicitly. See ' +
        'backend/.env.e2e.example for the full list and placeholder values.',
    );
  }

  const databaseUrl = source.E2E_DATABASE_URL!;
  const redisUrl = source.E2E_REDIS_URL!;
  const s3Endpoint = source.E2E_S3_ENDPOINT!;
  const s3Bucket = source.E2E_S3_BUCKET!;
  const s3AccessKeyId = source.E2E_S3_ACCESS_KEY_ID!;
  const s3SecretAccessKey = source.E2E_S3_SECRET_ACCESS_KEY!;

  assertLooksLikeTestResource('E2E_DATABASE_URL', databaseUrl);
  assertLooksLikeTestResource('E2E_S3_BUCKET', s3Bucket);
  assertLocalS3Endpoint(s3Endpoint);
  assertIsolatedRedisUrl(redisUrl);

  return {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: s3Bucket,
    S3_ACCESS_KEY_ID: s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
    S3_REGION: source.E2E_S3_REGION ?? 'us-east-1',
    S3_FORCE_PATH_STYLE: source.E2E_S3_FORCE_PATH_STYLE ?? 'true',
    // Config-level kill-switches, not just the per-spec DI overrides the
    // 19 spec files already use — this is what actually protects against
    // a live production worker winning a same-named-queue dequeue race
    // (see MalwareScanWorker/EmailSendWorker's own doc comments): even if
    // a spec's in-process worker never gets the job, the job itself was
    // enqueued from a process whose config already says "don't scan" /
    // "no real key", so whichever worker processes it stays safe.
    MALWARE_SCAN_ENABLED: 'false',
    POSTMARK_API_KEY: source.E2E_POSTMARK_API_KEY ?? '',
    POSTMARK_FROM_ADDRESS: source.E2E_POSTMARK_FROM_ADDRESS ?? '',
    SESSION_SECRET: source.E2E_SESSION_SECRET ?? 'e2e-isolated-session-secret-not-for-production',
  };
}
