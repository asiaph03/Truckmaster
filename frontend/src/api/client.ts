import { ApiError, type ApiErrorBody } from './errors';

// Beta Launch Hardening (Vercel + Render) — an absolute Render origin in
// production (VITE_API_BASE_URL, set on Vercel only), falling back to the
// relative path that local dev and the Docker/nginx same-origin
// deployment path both still rely on. Exported so the handful of raw
// fetch() call sites that bypass apiRequest() for CSV/blob downloads
// (documents.ts, loads.ts, reportCatalog.ts, reporting.ts) target the
// same backend instead of duplicating this fallback with their own
// hardcoded '/api/v1' string.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

// Beta Launch Hardening — stateless double-submit CSRF cookie/header.
// Names must match backend/src/common/security/csrf.constants.ts exactly
// (not imported directly — frontend and backend are separate TS
// projects, and this pair is small/stable enough not to warrant adding a
// cross-project shared-constants dependency for it).
const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** Reads one cookie by name from `document.cookie` — no cookie library needed for a single-value read. */
function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registered once at app boot (see src/auth/session-store.ts) so this
 * module doesn't need to import React/Zustand/Router directly. §9 of
 * the approved Phase 1 plan: a single 401 interceptor, not per-call
 * handling — clears session + query cache and redirects to /login.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  // Deliberately `object`, not `Record<string, ...>` — a named filter
  // interface (e.g. `CustomerListFilters`) has no index signature, and
  // TS won't structurally match it against a `Record<string, T>`
  // parameter type. Values are stringified defensively below regardless
  // of what the caller's interface declares.
  query?: object;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  // Beta Launch Hardening — must return the full absolute URL, not just
  // pathname+search: when API_BASE is an absolute Render origin, dropping
  // it here would silently send every request back to the frontend's own
  // origin instead of the backend. When API_BASE is still relative (dev/
  // same-origin nginx), `new URL(...)` already resolved it against
  // window.location.origin above, so this remains same-origin either way.
  return url.toString();
}

/**
 * The one shared fetch wrapper every typed API module goes through — no
 * ad hoc `fetch()` calls in components (§11 of the approved plan).
 * `credentials: 'include'` sends the httpOnly session cookie; there is
 * no Authorization header anywhere (no JWT/client-side token storage).
 *
 * Beta Launch Hardening — every non-GET call also attaches the
 * double-submit CSRF header centrally here, so every existing and future
 * API module gets it for free without touching individual call sites.
 * The cookie is bootstrapped by the backend on the very first request of
 * any browser session (see csrf-bootstrap.middleware.ts) — including an
 * unauthenticated one — so it's already present by the time a user
 * submits the login form.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrfToken = getCookie(CSRF_COOKIE_NAME);
    if (csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    credentials: 'include',
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    const errorBody: ApiErrorBody = payload?.error ?? {
      code: 'INTERNAL_ERROR',
      message: response.statusText || 'Request failed',
    };
    const error = new ApiError(response.status, errorBody);

    if (response.status === 401) {
      unauthorizedHandler?.();
    }
    throw error;
  }

  return payload as T;
}
