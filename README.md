# Truck Master TMS

A modern Transportation Management System, built stage-by-stage per the process documented in [`docs/`](docs/):

1. [Product Requirements Document](docs/PRD.md)
2. [Business Workflows](docs/workflows/) (10 locked workflows)
3. [System Architecture](docs/ARCHITECTURE.md) + [Architecture Decisions](docs/architecture-decisions.md)
4. [Database Design](docs/DATABASE_DESIGN.md)
5. [UI/UX Design](docs/UI_UX_DESIGN.md) + [interactive prototype](prototype/index.html)
6. [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md)
7. **Development** — in progress, this repository

## Repository Structure

```
docs/         Stage 1–6 design documents (source of truth for every business rule)
prototype/    Stage 5 interactive HTML/JS prototype — UI/UX reference only, not the backend
backend/      NestJS + Prisma + PostgreSQL modular monolith (Stage 7 implementation)
docker-compose.yml   Local dev infrastructure: Postgres, Redis, MinIO (S3-compatible)
```

## Local Development

**Prerequisites:** Node.js 20+, Docker + Docker Compose.

```bash
# 1. Start local infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# 2. Install backend dependencies
cd backend
npm install
cp .env.example .env

# 3. Apply the Prisma migrations (creates User/Organization/etc.)
npm run prisma:migrate:deploy

# 4. Apply Row-Level Security policies (kept separate from Prisma migrations —
#    see backend/prisma/rls/README.md for why)
npm run prisma:apply-rls

# 5. Run the app
npm run start:dev
```

### Verifying Phase 1 (Identity & Tenancy) against real infrastructure

The sandbox this codebase has been developed in has no Docker/PostgreSQL/Redis
available, so Phase 1 has only ever been verified against a mocked Prisma
layer (unit tests) — never against a live database. Run this on a machine
with Docker to close that gap:

```bash
# From the repo root
docker compose up -d
cd backend
npm install
cp .env.example .env

npm run build              # TypeScript compiles
npm run lint                # ESLint, zero warnings
npm test                    # unit tests (39 tests as of Phase 1)

npm run prisma:migrate:deploy   # applies the Phase 1 migration to Postgres
npm run prisma:apply-rls         # applies FORCE ROW LEVEL SECURITY policies

npm run test:e2e            # full Workflow 1 lifecycle + existing-identity
                             # reuse + cross-tenant RLS proof, against the
                             # real Postgres/Redis started above
```

`test/identity.e2e-spec.ts` is the file to watch: it proves the Workflow 1
lifecycle end-to-end (org creation → verification → invite → activation →
login → zero-Admin protection), the existing-global-User reuse path on
organization creation, and — critically — that PostgreSQL's `FORCE ROW LEVEL
SECURITY` itself rejects a raw cross-tenant query even when the app-layer
`WHERE` clause is bypassed entirely, not just that the service layer happens
to filter correctly. If any of these fail against real infrastructure, Phase 1
is not actually done regardless of what the mocked unit tests show.

## Current Status

**Stage 7, Phase 1 (Identity & Tenancy) implemented; build/lint/unit tests
green.** Live-infrastructure verification (Prisma migration apply, RLS
policy apply, E2E lifecycle, cross-tenant RLS proof) is written and ready
to run but has not been executed against a real PostgreSQL/Redis instance —
see "Verifying Phase 1" above. See
[`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) §15 for
the full phase sequence. Phase 2 (Core Master Data) is next once that
verification is complete.

Every business rule implemented in this codebase traces back to a specific section of a document in `docs/` — when in doubt about *why* the code does something, the docs are authoritative, not the code's comments.
