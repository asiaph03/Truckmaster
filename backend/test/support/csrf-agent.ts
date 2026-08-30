import request from 'supertest';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../../src/common/security/csrf.constants';

type SuperAgentTest = ReturnType<typeof request.agent>;

/**
 * Beta Launch Hardening — every e2e spec file drives the app through a
 * `request.agent(...)` (a real, cookie-persisting HTTP client, exactly
 * mirroring what a browser does). Now that CsrfGuard protects every
 * mutating route, each agent needs the same double-submit header the
 * real frontend's central API client attaches (frontend/src/api/client.ts)
 * — otherwise every existing POST/PATCH/PUT/DELETE call in the whole e2e
 * suite would 403.
 *
 * Bootstraps the CSRF cookie via one `GET /health` (public, unthrottled,
 * matches how a real page load bootstraps it before any login attempt),
 * then patches the agent's mutating verbs to attach the header — the
 * bootstrap middleware never rotates an already-issued token, so one
 * fetch per agent is enough for that agent's whole lifetime. This is a
 * test-only convenience; it does not change, weaken, or bypass the real
 * CsrfGuard — see security.e2e-spec.ts for tests that exercise the guard
 * directly (missing/mismatched token, safe-method exemption).
 */
export async function withCsrf(agent: SuperAgentTest): Promise<SuperAgentTest> {
  const res = await agent.get('/health');
  const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const token = cookies
    .map((c) => c.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`))?.[1])
    .find((v): v is string => Boolean(v));

  if (!token) {
    throw new Error('CSRF bootstrap cookie was not issued by GET /health.');
  }

  (['post', 'patch', 'put', 'delete'] as const).forEach((method) => {
    const original = agent[method].bind(agent);
    agent[method] = ((url: string) => original(url).set(CSRF_HEADER_NAME, token)) as never;
  });

  return agent;
}
