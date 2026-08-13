import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionAuthGuard } from './session-auth.guard';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { AuthenticationError } from '../../../common/errors/app-error';

function mockContext(session: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ session }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard (TECHNICAL_ARCHITECTURE.md §3.2/§3.5)', () => {
  it('allows a @Public() route through without a session', () => {
    const reflector = { getAllAndOverride: () => true } as unknown as Reflector;
    const guard = new SessionAuthGuard(reflector);
    RequestContextStore.run({ requestId: 'r1' }, () => {
      expect(guard.canActivate(mockContext(undefined))).toBe(true);
    });
  });

  it('throws AuthenticationError when no session exists on a non-public route', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new SessionAuthGuard(reflector);
    RequestContextStore.run({ requestId: 'r2' }, () => {
      expect(() => guard.canActivate(mockContext({}))).toThrow(AuthenticationError);
    });
  });

  it('throws AuthenticationError when session exists but has no auth payload', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new SessionAuthGuard(reflector);
    RequestContextStore.run({ requestId: 'r3' }, () => {
      expect(() => guard.canActivate(mockContext({ auth: undefined }))).toThrow(
        AuthenticationError,
      );
    });
  });

  it('extends RequestContext with the session identity and allows the request through', () => {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const guard = new SessionAuthGuard(reflector);
    RequestContextStore.run({ requestId: 'r4' }, () => {
      const auth = { userId: 'u1', organizationId: 'o1', membershipId: 'm1', roles: ['ADMIN'] };
      expect(guard.canActivate(mockContext({ auth }))).toBe(true);

      const ctx = RequestContextStore.current();
      expect(ctx.userId).toBe('u1');
      expect(ctx.organizationId).toBe('o1');
      expect(ctx.roles).toEqual(['ADMIN']);
    });
  });
});
