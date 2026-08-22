import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';

/**
 * The exact Redis key prefix `connect-redis`'s `RedisStore` uses for the
 * session store itself (configured via the `prefix` option in
 * `configure-app.ts`) — exported from here so both places that must agree
 * on the key format share one literal instead of two copies drifting.
 */
export const SESSION_REDIS_KEY_PREFIX = 'tms:sess:';

const INDEX_KEY_PREFIX = 'tms:sess-index:';
/** Matches the cookie's own 7-day `maxAge` (configure-app.ts) — bounds staleness even if a cleanup path is ever imperfect. */
const INDEX_TTL_SECONDS = 60 * 60 * 24 * 7;

function indexKey(userId: string, organizationId: string): string {
  return `${INDEX_KEY_PREFIX}${userId}:${organizationId}`;
}

/**
 * Post-Phase-8 remediation (Priority 2) — Workflow 1 §1.7: "Deactivated
 * user's active sessions are terminated immediately." `configure-app.ts`'s
 * own comment already states Redis-backed sessions were chosen specifically
 * so a deactivation could delete the session key server-side; this service
 * is the missing mechanism, not a new architecture — it maintains a small
 * reverse index (`userId`+`organizationId` -> the session IDs currently
 * selected to that org) so a deactivation can find and destroy exactly the
 * right Redis session key(s), without needing express-session to support
 * enumeration by user (which it doesn't, out of the box).
 *
 * Scoped to (`userId`, `organizationId`) rather than just `userId` — per
 * Workflow 1 §1.7, deactivation is a per-membership action. A session
 * currently selected to a DIFFERENT organization where the same user
 * remains Active must survive that deactivation.
 */
@Injectable()
export class SessionRegistryService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Call whenever a session's selected organization is set or changed
   * (login's auto-select case, `selectOrganization`, `switchOrganization`).
   * `previousOrganizationId` — when the session was already scoped to a
   * different org (a `switchOrganization` call) — is removed from that
   * org's set first, per §3.3's "full context switch, never a partial
   * merge": the old org can no longer revoke a session that switched away.
   */
  async recordActiveOrganization(
    sessionId: string,
    userId: string,
    organizationId: string,
    previousOrganizationId?: string,
  ): Promise<void> {
    if (previousOrganizationId && previousOrganizationId !== organizationId) {
      await this.redis.srem(indexKey(userId, previousOrganizationId), sessionId);
    }
    const key = indexKey(userId, organizationId);
    await this.redis.sadd(key, sessionId);
    await this.redis.expire(key, INDEX_TTL_SECONDS);
  }

  /** Call on logout — housekeeping only (the TTL above bounds staleness regardless). */
  async forget(sessionId: string, userId: string, organizationId: string): Promise<void> {
    await this.redis.srem(indexKey(userId, organizationId), sessionId);
  }

  /**
   * Workflow 1 §1.7 — destroys every session currently selected to this
   * (user, organization) pair by deleting its Redis session key directly,
   * so the next request on that cookie finds no session and
   * `SessionAuthGuard` rejects it with no per-request DB check added.
   */
  async revokeAllForOrganization(userId: string, organizationId: string): Promise<void> {
    const key = indexKey(userId, organizationId);
    const sessionIds = await this.redis.smembers(key);
    if (sessionIds.length === 0) return;

    await Promise.all(sessionIds.map((sid) => this.redis.del(`${SESSION_REDIS_KEY_PREFIX}${sid}`)));
    await this.redis.del(key);
  }
}
