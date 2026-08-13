-- RLS policies for Phase 2 (Core Master Data) tenant-scoped tables.
-- Apply AFTER the Prisma migration (20260814000000_phase2_core_master_data)
-- has been run against the target database. See prisma/rls/README.md for
-- the overall strategy.
--
-- Per DATABASE_DESIGN.md §26 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6, every
-- table introduced in this phase carries organization_id and gets a policy
-- — this is defense-in-depth behind the application layer's own explicit
-- `WHERE organization_id = ...` filtering, not a replacement for it.

ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "customer"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "customer_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_contact" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "customer_contact"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "customer_location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_location" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "customer_location"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "customer_rate_agreement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_rate_agreement" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "customer_rate_agreement"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier_contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_contact" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_contact"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier_insurance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_insurance" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_insurance"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier_fmcsa_verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_fmcsa_verification" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_fmcsa_verification"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier_service_area" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_service_area" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_service_area"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "carrier_factoring_info" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "carrier_factoring_info" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "carrier_factoring_info"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "driver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "driver" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "driver"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "truck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "truck" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "truck"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "trailer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trailer" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "trailer"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "document"
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- document_type_definition is the one table in this phase with a NULLABLE
-- organization_id (DATABASE_DESIGN.md §7, Decision Log D13): NULL means
-- "system-provided default type, available to every organization." A
-- plain equality policy (`organization_id = current_setting(...)::uuid`)
-- would hide every system-default row from every organization, since NULL
-- never equals a real UUID — breaking the seeded W9/COI/Rate Confirmation/
-- etc. rows entirely. The policy below explicitly allows NULL-org rows
-- through in addition to the tenant's own custom rows.
ALTER TABLE "document_type_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_type_definition" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_with_system_defaults ON "document_type_definition"
  USING (
    organization_id IS NULL
    OR organization_id = current_setting('app.current_org_id', true)::uuid
  );

-- Note on current_setting(..., true): see prisma/rls/0001_identity_rls.sql
-- for the full rationale (fail-closed NULL behavior, FORCE ROW LEVEL
-- SECURITY applying even to the table-owning application role) — identical
-- reasoning applies to every policy in this file.
