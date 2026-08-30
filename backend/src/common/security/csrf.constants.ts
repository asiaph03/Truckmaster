/**
 * Beta Launch Hardening — stateless double-submit-cookie CSRF protection
 * (TECHNICAL_ARCHITECTURE.md §11: "CSRF protection appropriate to
 * cookie-based sessions"). No server-side token storage — the token is
 * only ever compared cookie-value-vs-header-value, so it layers on top
 * of the existing session/Redis architecture without touching it.
 */
export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Methods that never mutate state — exempt from the CSRF check (§ safe methods). */
export const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
