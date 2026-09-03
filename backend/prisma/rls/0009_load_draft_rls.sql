-- RLS policy for the Rate Confirmation → New Load auto-populate feature's
-- LoadDraft table. Apply AFTER the Prisma migration
-- (20260904000000_add_load_draft) has been run against the target
-- database. See prisma/rls/README.md for the overall strategy.
--
-- load_draft carries a non-nullable organization_id and gets the
-- standard tenant_isolation policy — the same defense-in-depth layer
-- behind the application layer's own explicit `WHERE organization_id =
-- ...` filtering (LoadDraftService, always inside withTenantTransaction).

ALTER TABLE "load_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "load_draft" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "load_draft"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to this policy.
