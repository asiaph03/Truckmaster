-- RLS policies for Phase 3 (Load Lifecycle Core) tenant-scoped tables.
-- Apply AFTER the Prisma migration (20260815000000_phase3_load_lifecycle_core)
-- has been run against the target database. See prisma/rls/README.md for
-- the overall strategy.
--
-- Per DATABASE_DESIGN.md §8-9 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6,
-- every table introduced in this phase carries organization_id and gets a
-- policy — this is defense-in-depth behind the application layer's own
-- explicit `WHERE organization_id = ...` filtering, not a replacement for
-- it. All four tables here have a non-nullable organization_id — none of
-- them need the document_type_definition-style "system default" OR-clause,
-- and none of them are identity-bootstrap tables, so the plain
-- organization-only policy shape from 0002 applies unchanged.

ALTER TABLE "quote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "quote"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "quote_stop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_stop" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "quote_stop"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "load" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "load" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "load"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "stop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stop" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "stop"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to every policy in this file.
