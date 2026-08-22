import { ApiError, type ApiErrorBody } from './errors';

const API_BASE = '/api/v1';

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
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

/**
 * The one shared fetch wrapper every typed API module goes through — no
 * ad hoc `fetch()` calls in components (§11 of the approved plan).
 * `credentials: 'include'` sends the httpOnly session cookie; there is
 * no Authorization header anywhere (no JWT/client-side token storage).
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = options;

  const response = await fetch(buildUrl(path, query), {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
