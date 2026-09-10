import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RequestContextStore } from '../tenant-context/request-context';
import { AppError } from '../errors/app-error';

/**
 * Maps every thrown error to the consistent JSON error shape defined in
 * TECHNICAL_ARCHITECTURE.md §2.7:
 *   { "error": { "code": "...", "message": "...", "details": {...} } }
 *
 * The frontend keys its error-state UI off `code`, never message text
 * (UI_UX_DESIGN.md §5.5.3), so `code` is always a stable, machine-readable
 * identifier.
 *
 * Phase 1 adds the first real consumer of the `AppError` hierarchy
 * (common/errors/app-error.ts) — checked first, since every service-layer
 * business-rule failure throws one of those, not a NestJS `HttpException`.
 * `HttpException` remains handled for framework-level failures (e.g. the
 * global `ValidationPipe` in main.ts throws NestJS's own `BadRequestException`
 * for malformed request bodies, before any service code runs).
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = HttpStatus[status] ?? 'ERROR';
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        message = (b.message as string) ?? message;
        details = b;
      }
    }

    let requestId: string | undefined;
    let organizationId: string | undefined;
    let userId: string | undefined;
    try {
      const reqCtx = RequestContextStore.current();
      requestId = reqCtx.requestId;
      organizationId = reqCtx.organizationId;
      userId = reqCtx.userId;
    } catch {
      // Filter can run before context middleware in edge cases (e.g. a
      // malformed request Express rejects early) — context is best-effort.
    }

    if (status >= 500) {
      // Monitoring Phase 4A-7 — org/user correlation mirrors
      // HttpAccessLoggingMiddleware's own org=/user= convention, so a 5xx
      // is triageable from this single log line instead of needing to
      // cross-reference the separate HttpAccess line via requestId.
      const parts = [`[${requestId ?? 'no-request-id'}]`, request.method, request.url, '—', message];
      if (organizationId) parts.push(`org=${organizationId}`);
      if (userId) parts.push(`user=${userId}`);
      this.logger.error(parts.join(' '), exception instanceof Error ? exception.stack : undefined);
    }

    response.status(status).json({
      error: { code, message, details, requestId },
    });
  }
}
