import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context (TECHNICAL_ARCHITECTURE.md §3.5).
 *
 * organizationId is resolved ONLY from the authenticated session — never
 * from a request body/query/path parameter. This type is the single
 * source every service/repository call reads tenant scope from.
 *
 * userId/organizationId/membershipId/roles are undefined until the auth
 * layer (Phase 1 — Identity & Tenancy) populates them after verifying a
 * session. Phase 0 only establishes requestId (correlation ID, §9.3) so
 * every request is traceable from day one, per Stage 7 rule #6.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  organizationId?: string;
  membershipId?: string;
  roles?: string[];
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback);
  },

  current(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) {
      // A handler ran outside the request-context middleware — this is a
      // wiring bug, not a runtime condition to silently tolerate.
      throw new Error(
        'RequestContext accessed outside of an active request. ' +
          'Ensure RequestContextMiddleware is applied to this route.',
      );
    }
    return ctx;
  },

  /**
   * Convenience accessor used throughout the service layer (§3.5) — throws
   * rather than returning undefined, since every org-scoped query requires
   * this value and a missing one must never silently fall through to an
   * unscoped query.
   */
  requireOrganizationId(): string {
    const { organizationId } = this.current();
    if (!organizationId) {
      throw new Error('No organization selected for the current session.');
    }
    return organizationId;
  },

  /**
   * Convenience accessor mirroring requireOrganizationId, for service
   * methods that need to attribute an action to the acting user (AuditLog
   * actor_user_id, §3.7) and must never silently proceed unattributed.
   */
  requireUserId(): string {
    const { userId } = this.current();
    if (!userId) {
      throw new Error('No authenticated user for the current session.');
    }
    return userId;
  },

  /**
   * Populates auth-derived fields onto the *already-running* context
   * (Phase 1 — SessionAuthGuard, TECHNICAL_ARCHITECTURE.md §3.2/§3.5).
   *
   * Mutates the object AsyncLocalStorage is holding for this request,
   * rather than starting a nested `run()` — a NestJS Guard's
   * `canActivate()` only returns true/false; it doesn't wrap the
   * downstream handler in a callback the way Express middleware does, so
   * there is no natural place to call `run()` again. Since Node's
   * AsyncLocalStorage propagates one store *object* across every `await`
   * in the same request's continuation, mutating that object's own
   * properties here is visible to every `current()` call for the rest of
   * the request, including inside the controller/service/repository
   * layers invoked after the guard returns.
   */
  extend(fields: Partial<Omit<RequestContext, 'requestId'>>): void {
    Object.assign(this.current(), fields);
  },
};
