import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import type Redis from 'ioredis';
import { AppConfig } from './config/configuration';
import { REDIS_CLIENT } from './common/redis/redis.module';
import { SESSION_REDIS_KEY_PREFIX } from './modules/identity/services/session-registry.service';
import { buildCsrfBootstrapMiddleware } from './common/security/csrf-bootstrap.middleware';

// Prisma returns JS `BigInt` for `BigInt` columns (e.g. Document.fileSizeBytes)
// regardless of how the value was created — and `JSON.stringify`/Express's
// `res.json()` throws `TypeError: Do not know how to serialize a BigInt` on
// any response containing one, with no built-in escape hatch. This is a
// process-global runtime patch (not per-request config), applied once at
// module load — the standard fix for this well-known Prisma+Express gap.
// Values here are always byte counts well within Number's safe range, so
// converting to Number (not string) keeps the API response shape a plain
// JSON number, matching what CreateDocumentDto/UploadCarrierDocumentDto
// already declare as input.
declare global {
  interface BigInt {
    toJSON(): number;
  }
}
BigInt.prototype.toJSON = function (this: bigint) {
  return Number(this);
};

/**
 * Every process-level middleware/pipe the application needs, applied
 * identically by the real bootstrap (main.ts) and by every E2E test's app
 * instance. Extracted here specifically so E2E tests exercise the exact
 * same request pipeline as production — cookies, Redis-backed sessions,
 * global DTO validation, the `/api/v1` prefix — rather than a
 * `Test.createTestingModule()` instance that silently lacks all of it.
 *
 * (Self-caught during Phase 2 verification: E2E tests were building their
 * app via `moduleFixture.createNestApplication()` alone, which never ran
 * any of this — `req.session` was `undefined` on every E2E request,
 * unrelated to Redis reachability. This helper is the fix, not a
 * workaround: it makes both call sites share one real implementation
 * instead of `main.ts` and the tests silently diverging.)
 *
 * Call this after `NestFactory.create(AppModule)` /
 * `moduleFixture.createNestApplication()`, before `app.listen()` /
 * `app.init()`.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<AppConfig>);
  const isProduction = config.get('nodeEnv', { infer: true }) === 'production';

  // Beta Launch Hardening — the proposed deployment topology puts exactly
  // one reverse proxy (nginx) in front of this app; trusting the first
  // hop lets Express derive `req.ip`/`req.protocol` from the proxy's
  // X-Forwarded-* headers correctly (matters for the rate limiter below,
  // which keys on IP). Harmless when absent (local dev, e2e tests never
  // send X-Forwarded-* headers, so there's nothing to trust).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Vercel + Render deployment — the frontend and backend are on
  // different origins (yourdomain.com / api.yourdomain.com), so the
  // browser needs explicit CORS permission to read cross-origin
  // responses; `credentials: true` is required alongside `credentials:
  // 'include'` on the frontend for cookies to flow. Never a wildcard —
  // wildcard origin + credentials is rejected by browsers outright, and
  // an explicit single configured origin is the correct minimum here
  // regardless. Empty string (local dev, and the Docker/nginx
  // same-origin deployment path) never matches any real Origin header,
  // so this is a safe no-op in both of those cases — same-origin
  // requests aren't subject to CORS in the first place.
  app.enableCors({
    origin: config.get('corsOrigin', { infer: true }) as string,
    credentials: true,
  });

  // Security headers (§11 TECHNICAL_ARCHITECTURE.md). The CSP here covers
  // this backend's own responses (JSON API, /health) as defense in depth
  // — the CSP that actually governs the rendered SPA lives in
  // frontend/nginx.conf.template, since nginx (not this backend) serves
  // the built HTML/JS in the proposed deployment topology. Both lists are
  // kept in sync deliberately: 'self' only, plus the configured S3
  // endpoint's origin in connect-src (verified against the real Vite
  // production build — zero inline scripts/styles, zero other external
  // origins referenced anywhere in the frontend, so no unsafe-inline/
  // unsafe-eval is needed).
  const s3Origin = new URL(config.get('storage.endpoint', { infer: true }) as string).origin;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", s3Origin],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: isProduction ? [] : null,
        },
      },
    }),
  );
  app.use(cookieParser());

  // Beta Launch Hardening — issues the double-submit CSRF cookie (must
  // run after cookie-parser, which populates `req.cookies`, and before
  // CsrfGuard, which is registered globally in app.module.ts).
  app.use(buildCsrfBootstrapMiddleware(isProduction, config.get('cookieDomain', { infer: true })));

  // Redis-backed sessions (§3.2/§11) — chosen specifically so
  // deactivating a membership can revoke access immediately (Decision 3;
  // Workflow 1 §1.7 "Deactivated user's active sessions are terminated
  // immediately") by deleting the session key server-side, which a
  // stateless JWT cannot do without an additional revocation-list layer.
  // The `prefix` here must stay in sync with `SessionRegistryService`
  // (post-Phase-8 remediation), which is what actually performs that
  // deletion on deactivation — see session-registry.service.ts.
  const redisClient = app.get<Redis>(REDIS_CLIENT);
  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: SESSION_REDIS_KEY_PREFIX }),
      secret: config.get('session.secret', { infer: true }) as string,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    }),
  );

  // Shape validation at the API boundary (§2.4) — reject malformed
  // requests before they ever reach business logic. Business-rule
  // validation happens in the service layer, not here.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
}
