// LOCAL DRIVER DISPATCH EMAIL VERIFICATION ONLY — never used by the
// standard `npm run test:e2e` script (that command loads
// setup-e2e-env.ts instead, which deliberately targets the real
// backend/.env production config). This file exists so the dedicated
// driver-dispatch-email.local-verify.ts spec NEVER touches production
// Postgres/Redis/S3, no matter what backend/.env currently contains.
//
// dotenv (used internally by @nestjs/config's ConfigModule.forRoot())
// never overwrites a process.env key that is already set, so setting
// every sensitive key here — before ConfigModule loads backend/.env —
// guarantees these isolated values win regardless of the real file's
// contents.
process.env.DATABASE_URL =
  'postgresql://tms:tms_dev_password@127.0.0.1:5432/tms_local_test?schema=public';
process.env.REDIS_URL = 'redis://127.0.0.1:6379/1';
process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.S3_BUCKET = 'tms-documents';
process.env.S3_ACCESS_KEY_ID = 'S3RVER';
process.env.S3_SECRET_ACCESS_KEY = 'S3RVER';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.PORT = '3001';
process.env.NODE_ENV = 'development';
process.env.COOKIE_DOMAIN = '';
process.env.CORS_ORIGIN = '';

// Defense in depth on top of overriding the EMAIL_SENDER provider in the
// spec itself: even if that override were ever accidentally removed,
// PostmarkEmailSender would fail closed (auth error) rather than sending
// through a real account, since this process never sees a real key.
process.env.POSTMARK_API_KEY = '';
process.env.POSTMARK_FROM_ADDRESS = '';

// Not a real secret — this process only ever signs cookies for its own
// in-memory supertest client, never exposed externally. Set explicitly
// so this run never depends on whatever is in backend/.env.
process.env.SESSION_SECRET = 'local-driver-dispatch-e2e-verification-only';

// Same reasoning as test/setup-e2e-env.ts — many logins per run.
process.env.DISABLE_RATE_LIMIT_FOR_TESTS = 'true';
