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
docker-compose.yml   OPTIONAL local dev infrastructure (Postgres, Redis, MinIO) — see
              "Alternative: Docker Compose" below. Native Windows setup is primary.
```

## Local Development (primary: native Windows)

The application has no dependency on Docker, WSL, or containers of any kind — it only
needs something speaking the Postgres wire protocol on `DATABASE_URL`, something speaking
the Redis protocol on `REDIS_URL`, and something speaking the S3 API on `S3_ENDPOINT`. The
primary supported local setup runs all three natively on Windows:

| Component | What runs it | Notes |
|---|---|---|
| PostgreSQL | Native Windows PostgreSQL install | Already the target — no container |
| Redis | [Memurai](https://www.memurai.com/) (Developer edition, free) | Redis-protocol-compatible, native Windows Service, listens on `6379` by default. Genuine Redis has no first-party Windows build; Memurai is the actively-maintained, wire-compatible replacement — `ioredis` (what this app uses) can't tell the difference. |
| Object storage | [`s3rver`](https://github.com/jamhall/s3rver) (npm package, dev dependency) | S3-API-compatible mock server — pure Node.js, no binary download, no license concerns. Started via `npm run s3:local`. Requires no separate install step since it's already in `package.json`'s devDependencies. |
| DB administration | [pgAdmin](https://www.pgadmin.org/) | Optional but recommended for inspecting `tms_dev` directly |

**Prerequisites:** Node.js 20+, PostgreSQL running locally (already set up), Memurai installed and running. See "Installing Memurai natively" below if you haven't set it up yet — `s3rver` needs no separate install, it comes with `npm install`.

```bash
# 1. Install backend dependencies
cd backend
npm install
cp .env.example .env
# .env.example already targets 127.0.0.1:5432 / 127.0.0.1:6379 / 127.0.0.1:9000 —
# no edits needed if your local Postgres/Memurai use the default ports.

# 2. Start local S3-compatible storage (leave running in its own terminal)
npm run s3:local

# 3. Apply the Prisma migrations (creates User/Organization/etc.)
npm run prisma:migrate:deploy

# 4. Apply Row-Level Security policies (kept separate from Prisma migrations —
#    see backend/prisma/rls/README.md for why)
npm run prisma:apply-rls

# 5. Seed system-default document types (W9, COI, Rate Confirmation, etc. —
#    Phase 2, DATABASE_DESIGN.md §7 Decision Log D13)
npm run prisma:seed

# 6. Run the app
npm run start:dev
```

### Installing Memurai natively

1. Download "Memurai for Developers" (free) from memurai.com and run the installer.
2. It installs and starts as a Windows Service (`Memurai`) automatically, listening on `127.0.0.1:6379` — no further config needed for this project's defaults.
3. Verify: `Get-Service Memurai` (PowerShell) should show `Running`, or `redis-cli -h 127.0.0.1 -p 6379 ping` (Memurai ships a `memurai-cli.exe` that speaks the same protocol) should return `PONG`.

### Local S3-compatible storage (`s3rver`)

No separate install — `npm install` already pulls in `s3rver` as a dev dependency. Start it
with:

```bash
npm run s3:local
```

This runs `backend/scripts/start-local-s3.ts`, which:
- binds to `127.0.0.1:9000` (matches `S3_ENDPOINT` in `.env.example`)
- stores data on disk under `backend/.local-s3-data/` (gitignored)
- automatically creates the `tms-documents` bucket on every startup — no manual bucket-creation step, unlike the MinIO path this replaces

Leave it running in its own terminal alongside `npm run start:dev`. `StorageService` is
unmodified and unaware of what's actually serving `S3_ENDPOINT` — this is exactly the
"S3-compatible object storage" abstraction TECHNICAL_ARCHITECTURE.md §1.3 (Decision 9)
already specifies; only the local dev-time implementation behind that abstraction changed.

### Verifying Phase 1 + Phase 2 + Phase 3 against real infrastructure

```bash
cd backend
npm install
cp .env.example .env
npm run s3:local &          # start local S3-compatible storage (leave running)

npm run build              # TypeScript compiles
npm run lint                # ESLint, zero warnings
npm test                    # unit tests (122 tests as of Phase 3)

npm run prisma:migrate:deploy   # applies the Phase 1 + 2 + 3 migrations to Postgres
npm run prisma:apply-rls         # applies FORCE ROW LEVEL SECURITY policies (all three phases)
npm run prisma:seed              # seeds the 13 system-default document types

# Task #6 — npm run test:e2e now REQUIRES an explicit, isolated E2E_*
# environment (E2E_DATABASE_URL, E2E_REDIS_URL, E2E_S3_*) — see
# backend/.env.e2e.example for the full list and placeholder values. It
# hard-fails immediately if any is missing or looks production-like
# (backend/test/e2e-env-guard.ts); it never reads DATABASE_URL/REDIS_URL/
# S3_* from backend/.env, so the app's own dev/prod config can never be
# used by accident. Provision a SEPARATE Postgres database (not tms_dev)
# and a distinct Redis DB index (not DB 0) before running these:
export E2E_DATABASE_URL="postgresql://tms:tms_dev_password@127.0.0.1:5432/tms_e2e_test?schema=public"
export E2E_REDIS_URL="redis://127.0.0.1:6379/1"
export E2E_S3_ENDPOINT="http://127.0.0.1:9000"
export E2E_S3_BUCKET="tms-documents-e2e-test"
export E2E_S3_ACCESS_KEY_ID="S3RVER"
export E2E_S3_SECRET_ACCESS_KEY="S3RVER"

npm run test:e2e-safety     # fast guard-only tests, no DB/Redis/S3 needed
npm run test:e2e:bootstrap  # migrate + apply-rls + seed the isolated E2E DB
npm run test:e2e            # full Workflow 1 + 2/3 + 4 lifecycle, malware-
                             # scan quarantine, and cross-tenant RLS proof,
                             # against the isolated Postgres/Redis/S3-compatible
                             # storage above — never against your local dev
                             # database/Redis DB 0/real S3.
                             # Runs sequentially (--runInBand) — every e2e
                             # spec's AppModule starts a real BullMQ worker
                             # on the same Redis queue name, so running spec
                             # files in parallel worker processes races
                             # multiple app instances against one queue.
```

Three files to watch:

- `test/identity.e2e-spec.ts` — the Workflow 1 lifecycle end-to-end (org
  creation → verification → invite → activation → login → zero-Admin
  protection), the existing-global-User reuse path on organization creation,
  and cross-tenant RLS isolation for the Phase 1 tables.
- `test/core-master-data.e2e-spec.ts` — Customer creation + duplicate
  detection (Workflow 2), full Carrier onboarding through Activation
  including self-review prevention and the 7-condition eligibility gate
  (Workflow 3), a real presigned-URL document upload with the malware-scan
  worker actually quarantining an injected "infected" result, and
  cross-tenant RLS isolation for the Phase 2 tables.
- `test/load-lifecycle.e2e-spec.ts` — Workflow 4's two entry paths (Quote
  creation, Direct-to-Booked), Customer-status gating across both the Quote
  and Booking columns, Rate Agreement matching, Quote Won/Lost handling,
  Quote-to-Load conversion, independent Quote/Load numbering, reference
  numbers, the dispatcher-handoff boundary, role-based permissions and
  financial-field visibility, and cross-tenant RLS isolation for the
  Phase 3 tables.

All three prove that PostgreSQL's `FORCE ROW LEVEL SECURITY` itself rejects a raw
cross-tenant query even when the app-layer `WHERE` clause is bypassed
entirely, not just that the service layer happens to filter correctly. If
any of these fail against real infrastructure, the corresponding phase is
not actually done regardless of what the mocked unit tests show.

## Alternative: Docker Compose

Docker is **not required** — the native Windows setup above is primary. If you'd rather
run Postgres/Redis/MinIO as containers instead (e.g. on macOS/Linux, or if you simply
prefer it), `docker-compose.yml` at the repo root remains fully supported and uses the
exact same credentials/ports as `.env.example`. When using this path, skip `npm run
s3:local` entirely — the `minio` container serves `S3_ENDPOINT` instead:

```bash
docker compose up -d
# starts postgres (5432), redis (6379), minio (9000/9001), and a one-shot
# minio-init service that creates the tms-documents bucket automatically
cd backend
npm install
cp .env.example .env
# then continue from step 3 (prisma:migrate:deploy) in "Local Development" above
```

`docker compose ps` should show `postgres`/`redis`/`minio` as `running (healthy)` and
`minio-init` as `exited (0)` (success, not a failure).

## Current Status

**Stage 7, Phase 3 (Load Lifecycle Core) implemented and verified: build/lint/unit tests
green.** The `test:e2e` suite has grown to 19 files / 342 tests as of Task #6, which also
made it require an explicit isolated PostgreSQL + Redis + `s3rver` environment (see above) —
it must never be run against your local dev database/Redis/S3. Phase 1 (Identity & Tenancy) and Phase 2 (Core Master
Data) remain locked from their own verification passes. See
[`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) §15 for the full phase
sequence. Phase 4 (Sourcing & Dispatch) is next, pending explicit approval.

### Phase 3 implementation decisions

`docs/DATABASE_DESIGN.md §9` specifies `Stop.address_line1` as a plain (implicitly
required) `VARCHAR`. During implementation of Workflow 4 §4.7 (Quote → Load conversion),
this proved incompatible with `QuoteStop` (§8), which is deliberately lane-level only
(city/state/zip — "quotes need only lane-level info, not full appointment detail",
§4.2) and never captures a street address. A Load booked via Quote conversion has no
street address to carry forward for its Stops.

**Decision:** `Stop.addressLine1` is nullable (`backend/prisma/schema.prisma`, `Stop`
model). Direct-to-Booked Stops (Workflow 4 §4.8) still always populate it via
`LoadStopInputDto`, which keeps it required at the API boundary for that path;
`city`/`state`/`zip` remain required on `Stop` either way. This is an implementation-level
schema decision, not a reinterpretation of the locked Workflow 4 business rules — flagged
here per the same "stop and report genuine modeling gaps" standard applied throughout
Phase 1–3, rather than silently populating a placeholder value.

Every business rule implemented in this codebase traces back to a specific section of a document in `docs/` — when in doubt about *why* the code does something, the docs are authoritative, not the code's comments.
