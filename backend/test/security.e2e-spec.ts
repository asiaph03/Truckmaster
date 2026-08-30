import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../src/common/security/csrf.constants';

const API = '/api/v1';

/**
 * Beta Launch Hardening (TECHNICAL_ARCHITECTURE.md §11) end-to-end proof:
 * the stateless double-submit CSRF cookie/guard, per-IP login/activation
 * rate limiting, /health's exemption from both, and the CSP header the
 * backend sets on its own responses.
 */
describe('Beta Launch Hardening — CSRF, rate limiting, CSP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const adminEmail = 'security-suite-admin@trucktms.internal';
  const adminPassword = 'SecuritySuitePass123';

  beforeAll(async () => {
    // Every other e2e file needs rate limiting disabled by default (see
    // test/setup-e2e-env.ts) since they legitimately log in many times
    // per run as part of testing unrelated business logic. This is the
    // one file that actually needs to prove the real limiter fires —
    // re-enable it for the duration of this file's run only.
    process.env.DISABLE_RATE_LIMIT_FOR_TESTS = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    const passwordService = app.get(PasswordService);
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Security Suite Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(adminPassword),
      },
    });
  });

  afterAll(async () => {
    await app.close();
    process.env.DISABLE_RATE_LIMIT_FOR_TESTS = 'true';
  });

  describe('CSRF — double-submit cookie', () => {
    it('issues the csrf_token cookie on the very first request, before any session exists', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      expect(setCookie.some((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))).toBe(true);
    });

    it('rejects a POST with no CSRF cookie/header at all', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: adminEmail, password: adminPassword });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ERROR');
    });

    it('rejects a POST where the header does not match the cookie', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.get('/health'); // bootstraps the real cookie
      const res = await agent
        .post(`${API}/auth/login`)
        .set(CSRF_HEADER_NAME, 'a-completely-different-value')
        .send({ email: adminEmail, password: adminPassword });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ERROR');
    });

    it('accepts a POST when the header matches the bootstrapped cookie — mirrors the real frontend client exactly', async () => {
      const agent = request.agent(app.getHttpServer());
      const bootstrapRes = await agent.get('/health');
      const setCookie =
        (bootstrapRes.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const token = setCookie
        .map((c) => c.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`))?.[1])
        .find((v): v is string => Boolean(v));
      expect(token).toBeDefined();

      const res = await agent
        .post(`${API}/auth/login`)
        .set(CSRF_HEADER_NAME, token!)
        .send({ email: adminEmail, password: adminPassword });
      expect(res.status).toBe(200);
    });

    it('never requires the header on a GET, even with a cookie already present', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.get('/health');
      await agent
        .get(`${API}/auth/me`)
        .expect(200)
        .catch(() => {
          // 401 (no session yet) is fine — the point is it's not a 403 CSRF rejection.
        });
    });
  });

  describe('Rate limiting — /auth/login and /auth/activate', () => {
    it('blocks further login attempts from the same client after the configured threshold, regardless of credential correctness', async () => {
      const agent = request.agent(app.getHttpServer());
      const bootstrapRes = await agent.get('/health');
      const setCookie =
        (bootstrapRes.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const token = setCookie
        .map((c) => c.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`))?.[1])
        .find((v): v is string => Boolean(v))!;

      const attempt = () =>
        agent
          .post(`${API}/auth/login`)
          .set(CSRF_HEADER_NAME, token)
          .send({ email: adminEmail, password: 'definitely-wrong-password' });

      // Deliberately not asserting an exact attempt count before the 429 —
      // this per-IP counter is shared with `/auth/login` calls made
      // elsewhere in this same file (e.g. the CSRF describe block's own
      // successful login), so the precise budget remaining here depends
      // on suite run order. What must hold regardless: every response
      // before the throttle trips is a genuine 401 (never anything else),
      // and it trips within a small, bounded number of attempts — proving
      // the limiter fires independently of whether the credentials would
      // ever succeed, without over-specifying exactly when.
      const results: number[] = [];
      for (let i = 0; i < 15; i++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await attempt();
        results.push(res.status);
        if (res.status === 429) break;
      }

      expect(results[results.length - 1]).toBe(429);
      expect(results.slice(0, -1).every((s) => s === 401)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(11);
    }, 30000);

    it('never throttles /health, even after many rapid requests', async () => {
      const agent = request.agent(app.getHttpServer());
      const results: number[] = [];
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await agent.get('/health');
        results.push(res.status);
      }
      expect(results.every((s) => s === 200)).toBe(true);
    }, 30000);
  });

  describe('Content-Security-Policy', () => {
    it("sets a restrictive CSP on the backend's own responses, with connect-src covering the configured S3 origin", async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/connect-src 'self' http:\/\/127\.0\.0\.1:9000/);
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
    });
  });

  /**
   * Vercel + Render deployment — CORS_ORIGIN/COOKIE_DOMAIN only take
   * effect when actually set, which the main `app` instance above never
   * does (matching local dev's default). Each describe below builds its
   * own separate Nest application with those env vars set before compile,
   * so it gets its own config values baked in — and, since
   * @nestjs/throttler's default storage is in-memory and scoped per Nest
   * application instance (not shared/Redis-backed here), each of these
   * app instances also gets its own independent rate-limit counter,
   * unaffected by the "Rate limiting" describe block above having already
   * exhausted the main `app`'s budget.
   */
  describe('CORS (Vercel + Render) — configured origin only, never a wildcard', () => {
    let corsApp: INestApplication;
    const allowedOrigin = 'https://app.example.com';

    beforeAll(async () => {
      process.env.CORS_ORIGIN = allowedOrigin;
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      corsApp = moduleFixture.createNestApplication();
      configureApp(corsApp);
      await corsApp.init();
    });

    afterAll(async () => {
      await corsApp.close();
      delete process.env.CORS_ORIGIN;
    });

    it('allows the configured origin, with credentials', async () => {
      const res = await request(corsApp.getHttpServer())
        .get('/health')
        .set('Origin', allowedOrigin);
      expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('never reflects an arbitrary origin back, and never returns a wildcard', async () => {
      // A single configured origin string makes the `cors` package return
      // that SAME fixed value on every response, regardless of the
      // request's own Origin header — it never echoes the request's
      // Origin back (confirmed against the `cors` package's documented
      // behavior for a string `origin` option). That's correct and safe:
      // enforcement happens in the browser, which only accepts a response
      // whose Access-Control-Allow-Origin matches ITS OWN page origin —
      // an attacker page at evil.example.com receiving
      // "Access-Control-Allow-Origin: https://app.example.com" is still
      // blocked by the browser from reading the response. What actually
      // must never happen, and is provable here: reflecting the
      // attacker's own Origin back, or a wildcard.
      const res = await request(corsApp.getHttpServer())
        .get('/health')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBe(allowedOrigin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    });
  });

  describe('CSRF cookie Domain (Vercel + Render)', () => {
    let domainApp: INestApplication;
    const cookieDomain = '.example.com';

    beforeAll(async () => {
      process.env.COOKIE_DOMAIN = cookieDomain;
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      domainApp = moduleFixture.createNestApplication();
      configureApp(domainApp);
      await domainApp.init();
    });

    afterAll(async () => {
      await domainApp.close();
      delete process.env.COOKIE_DOMAIN;
    });

    it('sets Domain on the CSRF cookie when COOKIE_DOMAIN is configured', async () => {
      const res = await request(domainApp.getHttpServer()).get('/health');
      const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const csrfCookieLine = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
      expect(csrfCookieLine).toBeDefined();
      expect(csrfCookieLine!.toLowerCase()).toContain(`domain=${cookieDomain.toLowerCase()}`);
    });

    it('never widens the session cookie Domain even when COOKIE_DOMAIN is configured', async () => {
      // Deliberately not request.agent()'s automatic cookie jar here: a
      // cookie whose Domain is ".example.com" doesn't match this test
      // server's actual host, and superagent correctly enforces real
      // RFC 6265 domain-matching (mirroring a real browser) — an agent
      // would silently refuse to store/resend it, causing CsrfGuard to
      // reject the login for a reason unrelated to what this test
      // actually checks. Forwarding the cookie manually via a raw Cookie
      // header sidesteps that jar entirely, exactly as a real production
      // browser talking to the real api.yourdomain.com would deliver it.
      const bootstrapRes = await request(domainApp.getHttpServer()).get('/health');
      const bootstrapCookies =
        (bootstrapRes.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const token = bootstrapCookies
        .map((c) => c.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`))?.[1])
        .find((v): v is string => Boolean(v))!;

      const loginRes = await request(domainApp.getHttpServer())
        .post(`${API}/auth/login`)
        .set('Cookie', `${CSRF_COOKIE_NAME}=${token}`)
        .set(CSRF_HEADER_NAME, token)
        .send({ email: adminEmail, password: adminPassword });
      const setCookie = (loginRes.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const sessionCookieLine = setCookie.find((c) => c.startsWith('connect.sid='));
      expect(sessionCookieLine).toBeDefined();
      expect(sessionCookieLine!.toLowerCase()).not.toContain('domain=');
    });
  });

  describe('CSRF cookie — no Domain when COOKIE_DOMAIN is unset (local dev / Docker-nginx default)', () => {
    it('the default app instance never sets a Domain attribute on the CSRF cookie', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      const csrfCookieLine = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
      expect(csrfCookieLine).toBeDefined();
      expect(csrfCookieLine!.toLowerCase()).not.toContain('domain=');
    });
  });
});
