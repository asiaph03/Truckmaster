-- RLS policies for Phase 4 (Sourcing & Dispatch) tenant-scoped tables.
-- Apply AFTER the Prisma migration (20260817000000_phase4_sourcing_dispatch)
-- has been run against the target database. See prisma/rls/README.md for
-- the overall strategy.
--
-- Per DATABASE_DESIGN.md §10-12 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6,
-- every table introduced in this phase carries organization_id and gets a
-- policy — this is defense-in-depth behind the application layer's own
-- explicit `WHERE organization_id = ...` filtering, not a replacement for
-- it. All three tables here have a non-nullable organization_id — none of
-- them need the document_type_definition-style "system default" OR-clause,
-- and none of them are identity-bootstrap tables, so the plain
-- organization-only policy shape from 0002/0003 applies unchanged.

ALTER TABLE "carrier_sourcing_attempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_sourcing_attempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_sourcing_attempt"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "dispatch_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_record" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dispatch_record"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "check_call" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "check_call" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "check_call"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to every policy in this file.
