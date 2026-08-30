import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { CsrfError } from '../errors/app-error';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_SAFE_METHODS } from './csrf.constants';

/**
 * Beta Launch Hardening — stateless double-submit CSRF check
 * (TECHNICAL_ARCHITECTURE.md §11). Applies to every unsafe-method
 * request, including the two `@Public()` auth routes (`login`/
 * `activate`) — CSRF protection here is independent of whether a session
 * exists yet (see csrf-bootstrap.middleware.ts), so it deliberately does
 * NOT check `@Public()` the way SessionAuthGuard does.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (CSRF_SAFE_METHODS.has(request.method)) return true;

    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];
    const headerToken = request.headers[CSRF_HEADER_NAME];

    if (
      !cookieToken ||
      !headerToken ||
      typeof headerToken !== 'string' ||
      cookieToken !== headerToken
    ) {
      throw new CsrfError('Missing or invalid CSRF token.');
    }

    return true;
  }
}
