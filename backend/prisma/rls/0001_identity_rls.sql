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

ALTER TABLE "organization_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "organization_membership"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "membership_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_role" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "membership_role"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "organization_sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_sequence" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "organization_sequence"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- audit_log and domain_event (DATABASE_DESIGN.md §23-24) are also
-- organization_id-scoped and get the same policy, per §26's blanket rule
-- ("every table that carries organization_id"). Added in this same file
-- since both tables are introduced in the same Phase 1 migration.

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_log"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "domain_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "domain_event"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

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
-- FORCE ROW LEVEL SECURITY additionally ensures the policy applies even
-- to the table owner role, which the application's database user is
-- expected to be in this architecture (single application DB role, no
-- superuser bypass) — without FORCE, a table owner is exempt from RLS by
-- default in PostgreSQL, which would silently defeat the whole mechanism.
