import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { PermissionError } from '../../../common/errors/app-error';

function mockContext(): ExecutionContext {
  return { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

describe('RolesGuard (§7 Permissions Matrix — Guard-level coarse role check)', () => {
  it('allows the request through when the route declares no @Roles()', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    RequestContextStore.run({ requestId: 'r1', roles: [] }, () => {
      expect(guard.canActivate(mockContext())).toBe(true);
    });
  });

  it('allows the request through when the acting user holds one of the required roles', () => {
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    RequestContextStore.run({ requestId: 'r2', roles: ['DISPATCHER', 'ADMIN'] }, () => {
      expect(guard.canActivate(mockContext())).toBe(true);
    });
  });

  it('blocks the request when the acting user holds none of the required roles (e.g. Dispatcher on an Admin-only Membership action)', () => {
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    RequestContextStore.run({ requestId: 'r3', roles: ['DISPATCHER'] }, () => {
      expect(() => guard.canActivate(mockContext())).toThrow(PermissionError);
    });
  });

  it('blocks the request when the session has no roles at all', () => {
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    RequestContextStore.run({ requestId: 'r4' }, () => {
      expect(() => guard.canActivate(mockContext())).toThrow(PermissionError);
    });
  });
});
