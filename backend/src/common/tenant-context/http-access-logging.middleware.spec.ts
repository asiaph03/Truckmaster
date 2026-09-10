import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { HttpAccessLoggingMiddleware } from './http-access-logging.middleware';
import { RequestContextStore } from './request-context';

/**
 * Monitoring Phase 4A-1 Item 4 — tests the access-logging middleware in
 * complete isolation: `FakeResponse` only needs to look like Express's
 * `Response` for what this middleware actually uses (`statusCode`,
 * `on('finish', ...)`, and being an EventEmitter so tests can fire
 * `emit('finish')` directly) — no real HTTP server, no Nest bootstrap.
 */

class FakeResponse extends EventEmitter {
  statusCode = 200;
}

function buildReq(overrides: Partial<{ method: string; path: string; route: { path: string }; url: string; headers: Record<string, string>; session: unknown }> = {}) {
  return {
    method: 'GET',
    path: '/loads/abc123',
    headers: {},
    ...overrides,
  } as unknown as Parameters<HttpAccessLoggingMiddleware['use']>[0];
}

describe('HttpAccessLoggingMiddleware', () => {
  let middleware: HttpAccessLoggingMiddleware;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    middleware = new HttpAccessLoggingMiddleware();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // `afterUse` runs inside the same synchronous RequestContextStore.run()
  // frame as middleware.use(). This matters for `res.emit('finish')`
  // specifically: a real Express `res` is backed by Node's http.ServerResponse,
  // whose 'finish' event is emitted from async-hooks-tracked socket/stream
  // internals, so AsyncLocalStorage context flows to it automatically even
  // though the emit isn't lexically nested in the request's call stack. Our
  // FakeResponse is a bare EventEmitter test double with no such tracking —
  // `.on()` doesn't capture ALS context at registration time — so a test that
  // needs the listener to observe the request's context must emit() from
  // inside this callback to faithfully reproduce that continuation.
  function run(
    req: ReturnType<typeof buildReq>,
    res: FakeResponse,
    contextFields: { requestId: string; organizationId?: string; userId?: string } = { requestId: 'req-1' },
    afterUse?: () => void,
  ) {
    RequestContextStore.run(contextFields, () => {
      const next = jest.fn();
      middleware.use(req, res as never, next);
      expect(next).toHaveBeenCalledTimes(1);
      afterUse?.();
    });
  }

  it('1. a normal 2xx request below the slow threshold is NOT logged', () => {
    const req = buildReq({ route: { path: '/loads/:id' } });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 200;
    res.emit('finish');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('2. a 4xx request IS logged with method, route, status, duration, requestId', () => {
    const req = buildReq({ method: 'POST', route: { path: '/loads/:id' } });
    const res = new FakeResponse();
    run(req, res, { requestId: 'req-abc' }, () => {
      res.statusCode = 404;
      res.emit('finish');
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('POST');
    expect(message).toContain('/loads/:id');
    expect(message).toContain('404');
    expect(message).toMatch(/\d+ms/);
    expect(message).toContain('requestId=req-abc');
  });

  it('3. a 5xx request IS logged with the same required fields', () => {
    const req = buildReq({ method: 'GET', route: { path: '/reports/dashboard' } });
    const res = new FakeResponse();
    run(req, res, { requestId: 'req-xyz' }, () => {
      res.statusCode = 500;
      res.emit('finish');
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('GET');
    expect(message).toContain('/reports/dashboard');
    expect(message).toContain('500');
    expect(message).toMatch(/\d+ms/);
    expect(message).toContain('requestId=req-xyz');
  });

  it('4. a slow 2xx request IS logged', () => {
    const req = buildReq({ route: { path: '/reports/carrier-performance' } });
    const res = new FakeResponse();

    const realNow = Date.now;
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    run(req, res);
    now += 1500; // exceeds SLOW_REQUEST_THRESHOLD_MS (1000ms)

    res.statusCode = 200;
    res.emit('finish');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('200');
    expect(message).toContain('1500ms');

    (Date.now as jest.Mock).mockRestore?.();
    Date.now = realNow;
  });

  it('5. an authenticated request includes organizationId and userId', () => {
    const req = buildReq({ route: { path: '/loads/:id' } });
    const res = new FakeResponse();
    run(req, res, { requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' }, () => {
      res.statusCode = 404; // must be logged to inspect the message
      res.emit('finish');
    });

    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('org=org-1');
    expect(message).toContain('user=user-1');
  });

  it('6. an unauthenticated/public request omits organizationId and userId', () => {
    const req = buildReq({ route: { path: '/health' } });
    const res = new FakeResponse();
    run(req, res, { requestId: 'req-1' }); // no organizationId/userId set

    res.statusCode = 503; // non-2xx /health, so it should log
    res.emit('finish');

    const [message] = logSpy.mock.calls[0];
    expect(message).not.toContain('org=');
    expect(message).not.toContain('user=');
  });

  it('7. /health with a 2xx status is NOT logged', () => {
    const req = buildReq({ route: { path: '/health' } });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 200;
    res.emit('finish');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('7b. a slow /health request that is still 2xx remains excluded', () => {
    const req = buildReq({ route: { path: '/health' } });
    const res = new FakeResponse();

    const realNow = Date.now;
    let now = 2_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    run(req, res);
    now += 5000; // very slow, but still /health + 2xx

    res.statusCode = 200;
    res.emit('finish');

    expect(logSpy).not.toHaveBeenCalled();

    (Date.now as jest.Mock).mockRestore?.();
    Date.now = realNow;
  });

  it('8. /health with a non-2xx status IS logged', () => {
    const req = buildReq({ route: { path: '/health' } });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 503;
    res.emit('finish');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('/health');
    expect(message).toContain('503');
  });

  it('9. query-string values never appear in the log, even when present on the request', () => {
    const req = buildReq({
      route: { path: '/loads' },
      path: '/loads',
      url: '/loads?apiKey=SECRET123&search=jane%40example.com',
      headers: { authorization: 'Bearer secret-token-value' },
    });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 400;
    res.emit('finish');

    const [message] = logSpy.mock.calls[0];
    expect(message).not.toContain('apiKey');
    expect(message).not.toContain('SECRET123');
    expect(message).not.toContain('search=');
    expect(message).not.toContain('jane%40example.com');
    expect(message).not.toContain('?');
  });

  it('10. logs the route template, not a concrete/sensitive ID, when req.route.path is available', () => {
    const req = buildReq({
      route: { path: '/loads/:id/documents/:documentId' },
      path: '/loads/load-real-secret-id-999/documents/doc-real-id-888',
    });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 404;
    res.emit('finish');

    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('/loads/:id/documents/:documentId');
    expect(message).not.toContain('load-real-secret-id-999');
    expect(message).not.toContain('doc-real-id-888');
  });

  it('10b. falls back to req.path (no query string) when req.route is unavailable (e.g. a genuine 404)', () => {
    const req = buildReq({ route: undefined, path: '/no-such-route' });
    const res = new FakeResponse();
    run(req, res);

    res.statusCode = 404;
    res.emit('finish');

    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('/no-such-route');
  });

  it('11. never throws if RequestContextStore.current() would throw — logs with whatever is safely available', () => {
    const req = buildReq({ route: { path: '/loads/:id' } });
    const res = new FakeResponse();
    const next = jest.fn();

    // Deliberately NOT wrapped in RequestContextStore.run(...) — current()
    // throws "accessed outside of an active request" in this state.
    expect(() => middleware.use(req, res as never, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);

    expect(() => {
      res.statusCode = 500;
      res.emit('finish');
    }).not.toThrow();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(message).toContain('requestId=unknown');
  });

  it('12. the resulting log message never contains Authorization/cookie/query/body-like values', () => {
    const req = buildReq({
      route: { path: '/loads/:id' },
      headers: {
        authorization: 'Bearer super-secret-jwt-value',
        cookie: 'session=abc123; csrf_token=def456',
      },
      url: '/loads/abc123?token=leaked-secret',
    });
    const res = new FakeResponse();
    run(req, res, { requestId: 'req-1', organizationId: 'org-1', userId: 'user-1' });

    res.statusCode = 400;
    res.emit('finish');

    const [message] = logSpy.mock.calls[0];
    expect(message).not.toContain('Bearer');
    expect(message).not.toContain('super-secret-jwt-value');
    expect(message).not.toContain('cookie');
    expect(message).not.toContain('csrf_token');
    expect(message).not.toContain('session=abc123');
    expect(message).not.toContain('token=leaked-secret');
  });
});
