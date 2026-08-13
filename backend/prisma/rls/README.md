# Row-Level Security (RLS) Strategy

Source: [`docs/TECHNICAL_ARCHITECTURE.md`](../../../docs/TECHNICAL_ARCHITECTURE.md) §3.6, §4.6; [`docs/architecture-decisions.md`](../../../docs/architecture-decisions.md) Decision 4.

## Why raw SQL, not Prisma

Prisma has no schema DSL for `CREATE POLICY`/`ENABLE ROW LEVEL SECURITY`. RLS is applied as
plain SQL, tracked alongside (but separate from) Prisma's own migration history.

## Mechanism

1. The application sets a Postgres session variable at the start of every tenant-scoped
   transaction: `SELECT set_config('app.current_org_id', '<uuid>', true)` — done by
   `PrismaService.withTenantTransaction()` (`src/common/prisma/prisma.service.ts`).
2. Every tenant-scoped table has RLS enabled and a policy of the form:

   ```sql
   ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;

   CREATE POLICY tenant_isolation ON <table>
     USING (organization_id = current_setting('app.current_org_id')::uuid);
   ```

3. **This is defense-in-depth, not the primary mechanism.** Every repository/service method
   also filters explicitly by `organization_id` in application code — RLS exists to catch the
   case where that application-layer filter is ever missing due to a bug, not to be relied on
   as the only guard.

## Which tables get a policy

Every table in `docs/DATABASE_DESIGN.md` that carries `organization_id` — which, per Decision
Log D2, is **every table except** the two genuinely global ones: `User` and `Organization`
itself (see DATABASE_DESIGN.md §1, §26 for the full rationale).

## Applying policies

Policies are applied via a plain `.sql` file per Prisma migration that introduces new
tenant-scoped tables, run immediately after `prisma migrate dev`/`deploy`:

```
prisma/rls/
  0001_identity_rls.sql   # Phase 1 — organization_membership, membership_role,
                          # organization_sequence
  0002_customer_rls.sql   # Phase 2 — added when the Customer module lands
  ...
```

Applied via `npm run prisma:apply-rls` (`scripts/apply-rls.ts`), which reads every
`prisma/rls/*.sql` file in filename order and executes it against `DATABASE_URL`. Run this
immediately after `prisma migrate deploy`/`migrate dev` — never skip it, since a migration
that creates a new tenant-scoped table without its matching RLS file leaves that table
unprotected by the RLS safety net (the application-layer `organization_id` filter is still
the primary guard, but the whole point of RLS here is not to depend on that filter alone).

## Status

**Phase 1: `0001_identity_rls.sql` implemented**, covering `organization_membership`,
`membership_role`, `organization_sequence`, `audit_log`, and `domain_event` (all five
tenant-scoped tables introduced in Phase 1 — the latter two per TECHNICAL_ARCHITECTURE.md
§15's explicit "AuditLog/DomainEvent service" Phase 1 scope). Enabled with `FORCE ROW LEVEL SECURITY` (not just `ENABLE`) so the policy applies
even to the table-owning role the application connects as. Not yet applied against a live
database in this environment — see the Phase 1 report for why (no Postgres available in the
sandbox this was built in). Apply via `npm run prisma:apply-rls` once
`prisma migrate deploy` has run against a real database.
