-- RLS policies for Frontend Phase 7 (Load Detail Activity History)
-- tenant-scoped tables. Apply AFTER the Prisma migration
-- (20260825000000_activity_history) has been run against the target
-- database. See prisma/rls/README.md for the overall strategy.
--
-- Both communication_activity and internal_note carry a non-nullable
-- organization_id and need no per-recipient or other extra app-layer
-- scoping — the plain organization-only policy shape from 0002/0003/0004
-- applies unchanged, mirroring check_call's policy exactly.

ALTER TABLE "communication_activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_activity" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "communication_activity"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "internal_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "internal_note" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "internal_note"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to both policies in this file.
