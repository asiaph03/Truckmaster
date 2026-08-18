import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thin wrapper around PrismaClient adding the app's two cross-cutting
 * database concerns:
 *
 *  1. Lifecycle — connect on module init, disconnect on shutdown, so the
 *     health check and graceful shutdown both have a single place to hook.
 *  2. Tenant-scoped transactions (TECHNICAL_ARCHITECTURE.md §3.6, §4.5,
 *     §4.6) — every state-mutating service method that touches an
 *     RLS-protected table must run inside `withTenantTransaction`, which
 *     sets the Postgres session variable RLS policies key off
 *     (`app.current_org_id`) before any query in that transaction runs.
 *     This is the *defense-in-depth* layer — application-layer
 *     `WHERE organization_id = ...` filtering (added per-module starting
 *     Phase 1) remains the authoritative, primary layer; this method is
 *     what makes RLS actually engage as the safety net behind it.
 *
 * No Prisma models exist yet (Phase 0) — this class has nothing tenant-
 * scoped to query against until Phase 1 adds Organization/User/etc., but
 * the mechanism is established now per Stage 7 rule #6 ("implement tenant
 * isolation from the beginning, not as a later cleanup task").
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected to PostgreSQL');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs `fn` inside a transaction with `app.current_org_id` set for the
   * duration of that transaction, so every RLS policy
   * (`USING (organization_id = current_setting('app.current_org_id')::uuid)`)
   * engages correctly. `SET LOCAL` is transaction-scoped by Postgres
   * itself, so this can never leak across requests even under connection
   * pooling.
   */
  async withTenantTransaction<T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // Defense-in-depth even before the query hits the DB: reject anything
    // that isn't a well-formed UUID rather than trusting the caller.
    if (!UUID_RE.test(organizationId)) {
      throw new Error(`Invalid organizationId passed to withTenantTransaction: ${organizationId}`);
    }
    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      // set_config(...) is used instead of a string-interpolated
      // `SET LOCAL app.current_org_id = '<value>'` specifically so the
      // organizationId is passed as a bound query parameter (via Prisma's
      // tagged-template $executeRaw, which parameterizes correctly) rather
      // than concatenated into SQL text — no injection surface here even
      // though the UUID check above already constrains the input.
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Identity-bootstrap counterpart to `withTenantTransaction`, for the
   * narrow set of queries that must run *before* an organization context
   * exists — login's cross-org membership discovery, role resolution, and
   * the membership check that precedes selecting/switching an org (see
   * `organization_membership` / `membership_role`'s `tenant_isolation`
   * policies in prisma/rls/0001_identity_rls.sql for the matching
   * `app.current_user_id`-based policy clause). Sets a transaction-local
   * `app.current_user_id` instead of `app.current_org_id`; same
   * `set_config(..., true)` / no-leak-across-pooled-connections reasoning
   * applies.
   */
  async withUserTransaction<T>(
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(userId)) {
      throw new Error(`Invalid userId passed to withUserTransaction: ${userId}`);
    }
    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Identity-bootstrap helper for the one query that precedes even
   * `withUserTransaction`: accepting an invitation / verifying an account
   * by a mailed, single-use token. At that point no user is authenticated
   * yet — the token hash itself is the credential — so neither
   * `app.current_org_id` nor `app.current_user_id` can apply. Sets a
   * transaction-local `app.current_invitation_token_hash` that
   * `organization_membership`'s policy matches against
   * `invitation_token_hash` directly (not a UUID, so no UUID_RE check —
   * `TokenService.hash()` always produces a 64-char hex SHA-256 digest,
   * and set_config's bound parameter means there's no injection surface
   * regardless).
   */
  async withInvitationTokenTransaction<T>(
    tokenHash: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!tokenHash) {
      throw new Error('Invalid tokenHash passed to withInvitationTokenTransaction: empty value');
    }
    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.current_invitation_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    });
  }
}
