import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRoleName } from '@prisma/client';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { PermissionError } from '../../../common/errors/app-error';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Must run AFTER SessionAuthGuard (NestJS applies guards in array order —
 * see identity.module.ts / app.module.ts registration) since it reads
 * the roles SessionAuthGuard populated onto RequestContext.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MembershipRoleName[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { roles = [] } = RequestContextStore.current();
    const hasRole = required.some((r) => roles.includes(r));
    if (!hasRole) {
      throw new PermissionError(`This action requires one of: ${required.join(', ')}.`);
    }
    return true;
  }
}
