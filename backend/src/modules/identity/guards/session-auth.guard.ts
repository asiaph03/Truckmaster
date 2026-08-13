import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { AuthenticationError } from '../../../common/errors/app-error';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

/**
 * TECHNICAL_ARCHITECTURE.md §3.2/§3.5 — verifies a session exists, then
 * extends the Phase-0 RequestContext with the authenticated identity so
 * every downstream service call has userId/organizationId/membershipId/
 * roles available via `RequestContextStore.current()`, without needing
 * the controller to thread them through manually.
 *
 * Applied globally (identity.module.ts / app.module.ts) except on routes
 * explicitly marked @Public() — see public.decorator.ts.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.session?.auth;

    if (!auth?.userId) {
      throw new AuthenticationError('Authentication required.');
    }

    RequestContextStore.extend({
      userId: auth.userId,
      organizationId: auth.organizationId,
      membershipId: auth.membershipId,
      roles: auth.roles,
    });

    return true;
  }
}
