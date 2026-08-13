import { RequestContextStore } from './request-context';

/**
 * Phase 0 unit test — no live database/Redis required, per the Phase 0
 * acceptance criteria (docs/TECHNICAL_ARCHITECTURE.md §15 Phase 0).
 *
 * This is the first of the "organization/tenant isolation" test category
 * required by Stage 7 rule #9 — even before any tenant-scoped table
 * exists, the context-propagation mechanism itself is testable and tested
 * now, rather than deferred.
 */
describe('RequestContextStore', () => {
  it('throws when accessed outside an active request context', () => {
    expect(() => RequestContextStore.current()).toThrow(/accessed outside of an active request/);
  });

  it('makes the context available inside run()', () => {
    RequestContextStore.run({ requestId: 'test-request-1' }, () => {
      expect(RequestContextStore.current().requestId).toBe('test-request-1');
    });
  });

  it('isolates context between concurrent async operations', async () => {
    const results: string[] = [];

    const task = (requestId: string, delayMs: number) =>
      RequestContextStore.run({ requestId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // If context leaked between concurrent requests, this would read
        // the other task's requestId instead of its own — exactly the
        // failure mode tenant-isolation depends on never happening once
        // organizationId is added to this context in Phase 1.
        results.push(RequestContextStore.current().requestId);
      });

    await Promise.all([task('req-a', 20), task('req-b', 5)]);

    expect(results.sort()).toEqual(['req-a', 'req-b']);
  });

  it('requireOrganizationId throws when no organization is set on the context', () => {
    RequestContextStore.run({ requestId: 'test-request-2' }, () => {
      expect(() => RequestContextStore.requireOrganizationId()).toThrow(/No organization selected/);
    });
  });

  it('requireOrganizationId returns the organizationId once populated', () => {
    RequestContextStore.run({ requestId: 'test-request-3', organizationId: 'org-123' }, () => {
      expect(RequestContextStore.requireOrganizationId()).toBe('org-123');
    });
  });

  it('requireUserId throws when no user is set on the context', () => {
    RequestContextStore.run({ requestId: 'test-request-4' }, () => {
      expect(() => RequestContextStore.requireUserId()).toThrow(/No authenticated user/);
    });
  });

  describe('extend()', () => {
    it('populates auth-derived fields onto the running context (Phase 1 auth guard behavior)', () => {
      RequestContextStore.run({ requestId: 'test-request-5' }, () => {
        expect(RequestContextStore.current().userId).toBeUndefined();

        RequestContextStore.extend({
          userId: 'user-1',
          organizationId: 'org-1',
          membershipId: 'membership-1',
          roles: ['ADMIN'],
        });

        const ctx = RequestContextStore.current();
        expect(ctx.userId).toBe('user-1');
        expect(ctx.organizationId).toBe('org-1');
        expect(ctx.membershipId).toBe('membership-1');
        expect(ctx.roles).toEqual(['ADMIN']);
        // requestId, established by the Phase 0 middleware before any
        // auth guard runs, must survive extend() untouched.
        expect(ctx.requestId).toBe('test-request-5');
      });
    });

    it('is visible to code that reads current() after extend() was called earlier in the same request', () => {
      RequestContextStore.run({ requestId: 'test-request-6' }, () => {
        RequestContextStore.extend({ organizationId: 'org-2' });
        // Simulates a guard populating the context, then a controller/
        // service reading it later in the same request's continuation —
        // exactly the sequence a real request goes through.
        expect(RequestContextStore.requireOrganizationId()).toBe('org-2');
      });
    });

    it('does not leak extended fields across separate run() invocations', () => {
      RequestContextStore.run({ requestId: 'test-request-7' }, () => {
        RequestContextStore.extend({ organizationId: 'org-a' });
      });
      RequestContextStore.run({ requestId: 'test-request-8' }, () => {
        expect(RequestContextStore.current().organizationId).toBeUndefined();
      });
    });
  });
});
