-- RLS policies for Bulk CSV/Excel Import tenant-scoped tables. Apply
-- AFTER the Prisma migration (20260829000000_bulk_import) has been run
-- against the target database. See prisma/rls/README.md for the overall
-- strategy.
--
-- Both import_batch and import_batch_row carry a non-nullable
-- organization_id (import_batch_row's is denormalized directly onto the
-- row rather than requiring a join through import_batch, matching this
-- codebase's convention of every RLS-protected table carrying its own
-- organization_id) and need no per-user or other extra app-layer scoping
-- — the plain organization-only policy shape from 0002/0003/0004/0007
-- applies unchanged.

ALTER TABLE "import_batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batch" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "import_batch"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "import_batch_row" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batch_row" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "import_batch_row"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to both policies in this file.
