-- RLS policy for Needs Attention V2 (Phase B.1 — schema only, no
-- detectors/sweeps write to this table yet). Apply AFTER the Prisma
-- migration (20260927000000_add_attention_item) has been run against the
-- target database. See prisma/rls/README.md for the overall strategy.
--
-- attention_item has a non-nullable organization_id, is not an identity-
-- bootstrap table, and needs no "system default" OR-clause — the plain
-- organization-only policy shape from 0002/0003/0004 applies unchanged.

ALTER TABLE "attention_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attention_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "attention_item"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to this policy.
