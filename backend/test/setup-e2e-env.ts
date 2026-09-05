// Task #6 — production-safety fix. Before this, DATABASE_URL/REDIS_URL/
// S3_*/MALWARE_SCAN_ENABLED/POSTMARK_API_KEY were never overridden here,
// so every e2e spec's in-process Nest app silently loaded backend/.env —
// on this machine, the real TMSBackend production service's own config
// (real Postgres DB, real AWS S3 bucket, real Postmark/Cloudmersive
// keys). buildE2EEnv() requires an explicit, validated, isolated E2E_*
// value for every one of these before anything else in this file (and so
// before ConfigModule, which loads next) runs — see e2e-env-guard.ts for
// the exact hard-fail rules. `dotenv` never overwrites a process.env key
// that's already set, so assigning these here guarantees backend/.env's
// real values can never win, regardless of what they contain.
import { buildE2EEnv } from './e2e-env-guard';

Object.assign(process.env, buildE2EEnv(process.env));

// Same reasoning as historically — before any test file (and so before
// ConfigModule) runs — makes e2e specs see NODE_ENV=test instead, without
// touching backend/.env itself. This exists purely to keep
// configure-app.ts's `isProduction` false for e2e: with it true, the CSRF
// and session cookies are issued `Secure`, which the plain-HTTP supertest
// client used by every e2e spec can never send back, so the CSRF
// double-submit check 403s on literally the first login. No application
// security logic changes — same `isProduction` branch as always, just a
// different input in this one process.
process.env.NODE_ENV = 'test';

// Same reasoning as NODE_ENV above, for a second, independent cause of the
// exact same symptom: backend/.env's COOKIE_DOMAIN is the real production
// Vercel frontend domain (needed so the deployed frontend's JS can read the
// CSRF cookie across the Vercel/Render origin split — see
// csrf-bootstrap.middleware.ts's own doc comment). configure-app.ts sets
// that value as the cookie's `Domain` attribute whenever it's non-empty,
// regardless of `isProduction`. A cookie scoped to a `Domain` that doesn't
// match the request's actual host (127.0.0.1/localhost, for every e2e
// spec's in-memory supertest server) can never legitimately be stored or
// resent by a spec-compliant HTTP client, so the CSRF double-submit check
// fails exactly like the Secure-cookie case above, independent of it.
// Clearing it here (before ConfigModule loads .env, and only for this
// process) makes the cookie host-only for e2e, exactly as it already is
// for any plain non-Vercel deployment per that same doc comment.
process.env.COOKIE_DOMAIN = '';

// Same reasoning again — backend/.env's CORS_ORIGIN is the real
// production Vercel frontend origin; an e2e spec's supertest client has
// no Origin header matching it, which would otherwise make configure-app.ts's
// CORS check reject cross-origin-shaped requests. Cleared here for the
// same "host-only, plain non-Vercel deployment" reasoning as COOKIE_DOMAIN.
process.env.CORS_ORIGIN = '';

// Beta Launch Hardening — disables the real rate limiter for e2e runs by
// default (see app.module.ts's ThrottlerModule `skipIf`). Every e2e file
// except security.e2e-spec.ts logs in many times per run as an ordinary
// part of testing unrelated business logic, not the limiter itself;
// security.e2e-spec.ts explicitly flips this back to 'false' around its
// own tests so the real limiter is genuinely exercised there. Runs once,
// before any test file's imports, via Jest's `setupFiles`.
process.env.DISABLE_RATE_LIMIT_FOR_TESTS = 'true';
