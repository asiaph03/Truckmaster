-- RLS policies for Phase 7 (Notifications & Background Jobs) tenant-scoped
-- tables. Apply AFTER the Prisma migration
-- (20260821000000_phase7_notifications_background_jobs) has been run
-- against the target database. See prisma/rls/README.md for the overall
-- strategy.
--
-- Per DATABASE_DESIGN.md §25 and TECHNICAL_ARCHITECTURE.md §3.6/§4.6, the
-- notification table carries a non-nullable organization_id and gets the
-- standard tenant_isolation policy — the same defense-in-depth layer
-- behind the application layer's own explicit `WHERE organization_id =
-- ... AND recipient_user_id = ...` filtering. Per-recipient scoping is an
-- application-layer concern (NotificationService always adds the
-- recipient_user_id filter, mirroring how financial-field redaction is an
-- app-layer concern, not an RLS one) — RLS here only ever enforces the
-- tenant boundary, exactly like every other table's policy.

ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "notification"
  USING (organization_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Note on current_setting(..., true) and NULLIF(..., ''): see
-- prisma/rls/0001_identity_rls.sql for the full rationale (fail-closed
-- NULL behavior, the empirically-confirmed Postgres placeholder-GUC
-- revert-to-empty-string quirk under connection pooling, and FORCE ROW
-- LEVEL SECURITY applying even to the table-owning application role) —
-- identical reasoning applies to this policy.
