-- RLS policies for Phase 1 (Identity & Tenancy) tenant-scoped tables.
-- Apply AFTER the Prisma migration
-- (20260813122226_phase1_identity_tenancy) has been run against the
-- target database. See prisma/rls/README.md for the overall strategy.
--
-- Per DATABASE_DESIGN.md §1/§26 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6:
--   - "user" and "organization" are GLOBAL tables — no organization_id
--     column, no RLS policy. Access to them is gated entirely by the
--     application layer (joining through organization_membership first).
--   - "organization_membership" and "membership_role" ARE
--     organization_id-scoped and get a policy each, below.
--
-- This is defense-in-depth. The application layer's explicit
-- `WHERE organization_id = ...` filtering (added per-module in the
-- service layer) remains the primary, authoritative isolation
-- mechanism — these policies exist to catch the case where that filter
-- is ever missing due to an application bug.

-- organization_membership carries three additional, narrower access paths
-- beyond the standard org-context policy, all required by identity-
-- bootstrap queries that run *before* an org context can exist (see the
-- "Identity-bootstrap exceptions" note below for the full rationale):
--   1. app.current_user_id — a user looking up their own memberships
--      across every org they belong to (login's org discovery, org
--      select/switch's membership check, role resolution).
--   2. app.current_invitation_token_hash — looking up the one membership
--      row matching a mailed, single-use invitation/verification token,
--      before any user identity is established at all.
-- Both are additive OR-clauses: a row is still only reachable through one
-- of these three narrow, server-controlled contexts, never by a client-
-- supplied organization_id/user_id/token value bypassing the match itself.
ALTER TABLE "organization_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "organization_membership"
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    OR invitation_token_hash = NULLIF(current_setting('app.current_invitation_token_hash', true), '')
  );

-- membership_role has no direct user_id column (roles hang off a
-- membership row via membership_id), so its identity-bootstrap exception
-- is expressed as a subquery against organization_membership's own
-- user_id clause above — a role row is visible if the membership it
-- belongs to is visible under the current user's bootstrap context. This
-- only serves getRoles(); activate() never needs to read membership_role,
-- so no invitation-token clause exists here.
ALTER TABLE "membership_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_role" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "membership_role"
  USING (
    organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR membership_id IN (
      SELECT id FROM "organization_membership"
      WHERE user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );

ALTER TABLE "organization_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_sequence" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "organization_sequence"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- audit_log and domain_event (DATABASE_DESIGN.md §23-24) are also
-- organization_id-scoped and get the same policy, per §26's blanket rule
-- ("every table that carries organization_id"). Added in this same file
-- since both tables are introduced in the same Phase 1 migration.

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_log"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "domain_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "domain_event"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true): the `true` (missing_ok) argument
-- makes this return NULL instead of raising an error when
-- app.current_org_id has not been set for the current session/transaction
-- (e.g., a raw psql session, a maintenance script, or the Platform Super
-- Admin's organization-provisioning path, which intentionally operates
-- with NO organization context — see AuthService.createOrganization).
-- NULL organization_id can never equal a real UUID, so the policy still
-- denies access by default rather than erroring out — fail-closed, not
-- fail-open.
--
-- Note on NULLIF(..., ''): PrismaService.withTenantTransaction() sets
-- app.current_org_id via set_config(..., true) — transaction-local
-- (`SET LOCAL`) semantics, so the value itself never leaks the actual
-- org id across requests even under connection pooling. But empirically
-- (verified directly against Postgres, not assumed), once a placeholder
-- GUC in the unregistered `app.*` namespace has been set at least once on
-- a connection — even only transaction-locally — Postgres reverts it to
-- an EMPTY STRING after that transaction ends, not back to a true
-- "unset" NULL state, for the remainder of that connection's life. No
-- session-level command (RESET, or reassigning NULL as the transaction's
-- last statement) can undo this once-touched state. Since pooled
-- connections are reused across unrelated requests, a bare (non-tenant)
-- query landing on a connection that previously ran ANY tenant
-- transaction would otherwise crash on `''::uuid` (`invalid input syntax
-- for type uuid`) instead of failing closed. `NULLIF(x, '')` collapses
-- both representations of "no context" (true NULL and reverted-empty-
-- string) into the same NULL value this policy already correctly treats
-- as "match nothing" — restoring the intended fail-closed behavior
-- without weakening it: a real tenant context still compares normally.
--
-- FORCE ROW LEVEL SECURITY additionally ensures the policy applies even
-- to the table owner role, which the application's database user is
-- expected to be in this architecture (single application DB role, no
-- superuser bypass) — without FORCE, a table owner is exempt from RLS by
-- default in PostgreSQL, which would silently defeat the whole mechanism.
--
-- Identity-bootstrap exceptions (organization_membership /
-- membership_role only): a strict organization_id-only policy makes
-- organization_membership unreadable during the handful of queries that
-- exist specifically to *discover* which org_id applies, before any org
-- context can legitimately be set. Three such queries exist, each needing
-- a different, narrower context:
--   - Login's cross-org membership discovery (listActiveMemberships) and
--     role resolution (getRoles) — a user reading their own memberships/
--     roles across every org they belong to. Scoped by app.current_user_id
--     (PrismaService.withUserTransaction), set from the already-verified
--     (password-checked) session's userId — never client-supplied.
--   - Org select/switch's membership-ownership check
--     (AuthService.resolveOrganizationSession) — must confirm the caller
--     actually belongs to the requested org *before* that org_id can be
--     trusted as the session's context; also scoped by
--     app.current_user_id for the same reason.
--   - Invitation/verification accept (MembershipService.activate) — looks
--     up a membership by a mailed, single-use token hash; no user
--     identity exists yet at all, so neither current_org_id nor
--     current_user_id applies. Scoped by
--     app.current_invitation_token_hash (PrismaService.
--     withInvitationTokenTransaction), matched against the stored SHA-256
--     hash (TokenService) — the raw token is never persisted, so this
--     grants nothing to anyone who hasn't already received the emailed
--     link.
-- Each of the three is a narrow, additive OR-clause set only by the
-- server from already-established trust (a verified password, an
-- already-scoped session, or a matched secret hash) — never from an
-- unvalidated client-supplied value — so this does not weaken the
-- fail-closed default: a request with none of the three contexts set
-- still sees no rows.
