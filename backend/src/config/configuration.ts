/**
 * Central, typed configuration loader. Every environment variable the
 * application reads is declared here — nothing reads process.env directly
 * anywhere else in the codebase, so the full configuration surface is
 * always visible in one place.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  /**
   * Self-hosted beta — the address the HTTP server binds to. Defaults to
   * `0.0.0.0` (all interfaces), matching Nest's own default and required
   * for Docker/Render, where the platform's reverse proxy reaches the
   * container over its network interface, not literal loopback. Set to
   * `127.0.0.1` only when a local reverse proxy (e.g. Cloudflare Tunnel)
   * on the same machine is the sole intended entry point.
   */
  host: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  session: {
    secret: string;
  };
  /**
   * Workflow 6 / PRD check-call reminder feature (Stage 6 §10.1, §17 S1).
   * Fixed, non-configurable-per-organization in V1 per the locked Stage 6
   * resolution — isolated here as a single named constant so a future phase
   * can source it from Organization-level config without an architectural
   * change, per Stage 7 rule #10.
   */
  checkCallReminderHours: number;
  /** Frontend Phase 16 — hosted malware-scanning provider (behind IMalwareScanner). */
  cloudmersive: {
    apiKey: string;
  };
  /** Frontend Phase 16 — hosted transactional email provider (behind IEmailSender). */
  postmark: {
    apiKey: string;
    fromAddress: string;
  };
  /**
   * Vercel + Render deployment — the frontend's production origin, used
   * for both CORS (§ configure-app.ts) and the CSRF cookie's Domain
   * attribute (§ csrf-bootstrap.middleware.ts). Empty string in local dev
   * and in the Docker/nginx same-origin deployment path, neither of which
   * needs cross-origin CORS at all.
   */
  corsOrigin: string;
  /**
   * Vercel + Render deployment — shared parent domain (e.g.
   * ".yourdomain.com") the CSRF cookie's Domain attribute is widened to,
   * so frontend JS on the Vercel origin can read a cookie issued by the
   * Render origin via document.cookie. Empty string leaves the cookie
   * host-only, exactly as today — local dev and the Docker/nginx
   * same-origin path must never set this.
   */
  cookieDomain: string;
  /**
   * Frontend Phase 23 — the frontend's absolute origin, used to build
   * clickable links in transactional emails (invitation/verification —
   * see MembershipService.invite/resend, OrganizationService.createOrganization).
   * Empty string in local dev, where these links are informational only.
   */
  appBaseUrl: string;
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  database: {
    url: process.env.DATABASE_URL || '',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  storage: {
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'tms-documents',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  },
  session: {
    secret: process.env.SESSION_SECRET || '',
  },
  checkCallReminderHours: parseInt(process.env.CHECK_CALL_REMINDER_HOURS || '4', 10),
  cloudmersive: {
    apiKey: process.env.CLOUDMERSIVE_API_KEY || '',
  },
  postmark: {
    apiKey: process.env.POSTMARK_API_KEY || '',
    fromAddress: process.env.POSTMARK_FROM_ADDRESS || '',
  },
  corsOrigin: process.env.CORS_ORIGIN || '',
  cookieDomain: process.env.COOKIE_DOMAIN || '',
  appBaseUrl: process.env.APP_BASE_URL || '',
});
