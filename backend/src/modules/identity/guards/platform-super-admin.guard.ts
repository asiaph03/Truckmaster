import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { UserService } from '../services/user.service';
import { AuthenticationError, PermissionError } from '../../../common/errors/app-error';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * Platform-console guard (ARCHITECTURE.md §1.1's two-tier structure).
 * Deliberately does NOT go through the normal organizationId-bearing
 * session context — a Platform Super Admin acts with no organization
 * selected (Decision 1 — no automatic access to any org's data). This
 * guard only checks `User.isPlatformSuperAdmin`; it still requires a
 * logged-in session (SessionAuthGuard runs first) so the acting identity
 * is known for audit attribution.
 */
@Injectable()
export class PlatformSuperAdminGuard implements CanActivate {
  constructor(private readonly userService: UserService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.session?.auth?.userId;
    if (!userId) {
      throw new AuthenticationError('Authentication required.');
    }

    const user = await this.userService.findById(userId);
    if (!user?.isPlatformSuperAdmin) {
      throw new PermissionError('This action requires Platform Super Admin access.');
    }

    RequestContextStore.extend({ userId: user.id });
    return true;
  }
}
