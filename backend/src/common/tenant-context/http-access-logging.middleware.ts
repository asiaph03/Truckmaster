import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { RequestContextStore } from './request-context';

/**
 * Monitoring Phase 4A-1 Item 4 — minimal HTTP access logging. Registered
 * immediately after RequestContextMiddleware (app.module.ts), applied to
 * every route.
 *
 * Deliberately implemented as middleware, not an interceptor: a NestJS
 * interceptor's success (`tap`) callback never fires when a guard/
 * controller throws — which is the normal path for every 4xx/5xx today,
 * since AppExceptionFilter is what actually converts a thrown AppError/
 * HttpException into the final response. Capturing the true final status
 * code for BOTH the success and the exception-filter-produced-response
 * paths, without duplicating the filter's own status-mapping logic,
 * requires observing the real HTTP response after it's been sent —
 * `res.on('finish', ...)` does exactly that, regardless of which code
 * path produced the response. Registering this middleware right after
 * RequestContextMiddleware means its `res.on('finish', ...)` listener is
 * registered synchronously inside that middleware's active
 * `RequestContextStore.run()` continuation, so the AsyncLocalStorage
 * context is still correctly available when the listener fires.
 *
 * Never reads req.originalUrl/req.url (both include the query string),
 * req.body, req.session, or any header — only method, the matched route
 * *pattern* (req.route.path, e.g. "/loads/:id" — never a real ID or query
 * value), the final status code, duration, and whatever is already safely
 * present on RequestContextStore (requestId always; organizationId/userId
 * only when the request was authenticated — never inferred, never looked
 * up).
 */

/** Requests slower than this are logged even when they succeed (2xx). */
const SLOW_REQUEST_THRESHOLD_MS = 1000;

@Injectable()
export class HttpAccessLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpAccess');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const status = res.statusCode;
      const route = req.route?.path ?? req.path;

      const isHealthCheck = route === '/health';
      const isSlow = durationMs > SLOW_REQUEST_THRESHOLD_MS;
      const isFailure = status >= 400;

      // /health: only ever logged when it's actually unhealthy — a
      // healthy poll (from the external uptime monitor or anything else)
      // is expected, high-frequency, and not worth a log line even when
      // slow; a non-2xx health response is itself the signal that matters.
      if (isHealthCheck) {
        if (!isFailure) return;
      } else if (!isFailure && !isSlow) {
        return;
      }

      // Mirrors AppExceptionFilter's own defensive read — this listener
      // can in principle fire in a context where the request-context
      // AsyncLocalStorage store is unavailable; never let that crash the
      // process or block the response, which has already been sent.
      let requestId: string | undefined;
      let organizationId: string | undefined;
      let userId: string | undefined;
      try {
        const ctx = RequestContextStore.current();
        requestId = ctx.requestId;
        organizationId = ctx.organizationId;
        userId = ctx.userId;
      } catch {
        // No active request context — log with whatever is available.
      }

      const parts = [
        `${req.method} ${route}`,
        `${status}`,
        `${durationMs}ms`,
        `requestId=${requestId ?? 'unknown'}`,
      ];
      if (organizationId) parts.push(`org=${organizationId}`);
      if (userId) parts.push(`user=${userId}`);

      this.logger.log(parts.join(' '));
    });

    next();
  }
}
