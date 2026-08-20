-- RLS policies for Phase 6 (Financials) tenant-scoped tables.
-- Apply AFTER the Prisma migration (20260819000000_phase6_financials)
-- has been run against the target database. See prisma/rls/README.md for
-- the overall strategy.
--
-- Per DATABASE_DESIGN.md §14-18 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6,
-- every table introduced in this phase carries organization_id and gets a
-- policy — this is defense-in-depth behind the application layer's own
-- explicit `WHERE organization_id = ...` filtering, not a replacement for
-- it. Seven of the eight tables have a non-nullable organization_id and
-- use the standard tenant_isolation policy from 0002-0004; charge_type_
-- definition mirrors document_type_definition's nullable-organization_id
-- "system default" OR-clause exactly (Decision Log D13), for the same
-- reason: NULL means "system-provided default charge type, available to
-- every organization."

ALTER TABLE "charge_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "charge_line_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "charge_line_item"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "invoice"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "invoice_load" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_load" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "invoice_load"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "invoice_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "invoice_line_item"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "payment"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "adjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "adjustment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "adjustment"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "carrier_payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_payment" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_payment"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- charge_type_definition — nullable organization_id (DATABASE_DESIGN.md
-- §14, Decision Log D13), mirrors document_type_definition's policy
-- exactly (0002_core_master_data_rls.sql) — NULL rows (system defaults)
-- must remain visible to every organization, not hidden by a plain
-- equality check.
ALTER TABLE "charge_type_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "charge_type_definition" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_with_system_defaults ON "charge_type_definition"
  USING (
    organization_id IS NULL
    OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to every policy in this file.
