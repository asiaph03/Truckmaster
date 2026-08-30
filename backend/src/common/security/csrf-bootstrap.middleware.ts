import { randomBytes } from 'node:crypto';
import { Request, RequestHandler, Response } from 'express';
import { CSRF_COOKIE_NAME } from './csrf.constants';

/**
 * Beta Launch Hardening — issues the double-submit CSRF cookie on the
 * first request of a browser session, before any session/login exists.
 * Runs on every request (global middleware, after cookie-parser), so by
 * the time the frontend's app-boot `GET /auth/me` call returns, the
 * cookie is already set — `POST /auth/login`/`POST /auth/activate` can
 * then be protected by the same check as every other mutating route,
 * with no special-casing for "not logged in yet" required.
 *
 * Non-`httpOnly` deliberately — the frontend API client
 * (`frontend/src/api/client.ts`) must be able to read it to echo it back
 * as a header. This is the standard double-submit shape: an attacker's
 * cross-site page can trigger a request that *carries* the cookie, but
 * cannot *read* it to also set the matching header, since it originates
 * from a different origin.
 *
 * Vercel + Render deployment — `cookieDomain`, when provided (production
 * only, e.g. ".yourdomain.com"), widens the cookie's Domain attribute so
 * it's visible to `document.cookie` on both the Vercel frontend origin
 * and this Render API origin, not just the one that issued it. A
 * host-only cookie set by api.yourdomain.com is otherwise invisible to
 * `document.cookie` on yourdomain.com — the browser still *sends* it back
 * (same-site, SameSite=Lax), but frontend JS can never *read* it to
 * populate the X-CSRF-Token header, which would 403 every mutating
 * request. Deliberately scoped to this cookie only — the session cookie
 * (configure-app.ts) stays host-only: it's httpOnly (never read by JS)
 * and only ever needs to be *sent* to the API origin, which same-site
 * already covers without any Domain widening.
 */
export function buildCsrfBootstrapMiddleware(
  isProduction: boolean,
  cookieDomain?: string,
): RequestHandler {
  return (req: Request, res: Response, next: () => void) => {
    if (!req.cookies?.[CSRF_COOKIE_NAME]) {
      const token = randomBytes(32).toString('hex');
      res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7, // matches the session cookie's 7-day lifetime
        ...(cookieDomain ? { domain: cookieDomain } : {}),
      });
      // So the guard on *this same* request sees the freshly-issued
      // token immediately, without waiting for the browser round-trip.
      req.cookies[CSRF_COOKIE_NAME] = token;
    }
    next();
  };
}
