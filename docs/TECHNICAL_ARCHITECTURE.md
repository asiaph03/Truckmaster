# Stage 6: Technical Architecture / Implementation Plan
**Status:** 🔒 COMPLETE — all blocking decisions (B1–B4) resolved; one small non-blocking business confirmation remains (exact check-call interval, §17 S1). No application code has been written.
**Source of truth, in order:** [PRD.md](PRD.md) → [workflows/01–10](workflows/) → [ARCHITECTURE.md](ARCHITECTURE.md) → [architecture-decisions.md](architecture-decisions.md) → [DATABASE_DESIGN.md](DATABASE_DESIGN.md) → [UI_UX_DESIGN.md](UI_UX_DESIGN.md) → [prototype/index.html](../prototype/index.html)
**Scope:** Technical design and implementation planning only. No source code, migrations, API implementations, React components, or deployment configuration are written here.

## How to read this document
Every non-trivial decision is tagged:
- 🔒 **LOCKED** — carried directly from a prior stage; not reinterpreted here.
- ✅ **CONFIRMED (Stage 6)** — a technical decision this stage makes explicit, within the bounds of what was already locked (e.g., picking a specific ORM given the already-locked "PostgreSQL + Node/TypeScript" stack).
- 🟡 **RECOMMENDED** — a reasonable default proposed here, awaiting your explicit approval before Stage 7 treats it as final.
- 🔴 **BLOCKING — DECISION REQUIRED** — something no prior document resolves, called out per your instruction rather than silently decided.

All 🔴 items are collected in §17.

---

## 1. System Architecture

### 1.1 Application Structure 🔒 (Architecture §1, §6; Decision 12)
One backend deployable (**modular monolith**), one frontend deployable (SPA), communicating over a versioned internal REST API (`/api/v1`). No microservices, no per-module deployments, no external integrations in V1.

```
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│  Frontend (React SPA)    │ HTTPS  │  Backend (Node.js/TypeScript, NestJS) │
│  UI_UX_DESIGN.md §5.1–5.6│◄──────►│  /api/v1/*                            │
└─────────────────────────┘        │  ┌──────────────────────────────────┐ │
                                    │  │ Controllers (thin, DTO-only)     │ │
                                    │  ├──────────────────────────────────┤ │
                                    │  │ Service Layer (workflow logic)   │ │
                                    │  ├──────────────────────────────────┤ │
                                    │  │ Domain Layer (state machines)    │ │
                                    │  ├──────────────────────────────────┤ │
                                    │  │ Data Access Layer (ORM/repos)    │ │
                                    │  └──────────────────────────────────┘ │
                                    └──────────────┬─────────────────────────┘
                                                    │
                    ┌───────────────────────────────┼───────────────────────────┐
                    ▼                                ▼                           ▼
            ┌───────────────┐               ┌────────────────┐         ┌────────────────┐
            │  PostgreSQL   │               │  Redis          │         │ S3-compatible  │
            │  (+ RLS)      │               │ (sessions,      │         │ object storage │
            │               │               │  BullMQ queue)  │         │ (documents)    │
            └───────────────┘               └────────┬────────┘         └────────────────┘
                                                       │
                                             ┌─────────▼─────────┐
                                             │ Background Workers │
                                             │ (same service layer│
                                             │  as the API — never│
                                             │  a parallel path)  │
                                             └────────────────────┘
```

### 1.2 Module Boundaries ✅ (confirms Architecture §6 as the final Stage 7 module list)
| Module | Owns (DATABASE_DESIGN.md tables) | Workflows |
|---|---|---|
| **Identity** | User, OrganizationMembership, MembershipRole | 1 |
| **Organization** | Organization, OrganizationSequence | 1 |
| **Customer** | Customer, CustomerContact, CustomerLocation, CustomerRateAgreement | 2 |
| **Carrier** | Carrier, CarrierContact, CarrierInsurance, CarrierFmcsaVerification, CarrierServiceArea, CarrierFactoringInfo, Driver, Truck, Trailer | 3 |
| **Quote/Load** | Quote, QuoteStop, Load, Stop | 4, 6 |
| **Sourcing** | CarrierSourcingAttempt | 5 |
| **Dispatch/Tracking** | DispatchRecord, CheckCall | 6 |
| **Document** | Document, DocumentTypeDefinition | 3, 5, 7 |
| **Billing** | Invoice, InvoiceLoad, InvoiceLineItem, Payment, Adjustment, ChargeLineItem, ChargeTypeDefinition | 8 |
| **CarrierPay** | CarrierPayment | 9 |
| **Audit** | AuditLog, DomainEvent | all |
| **Notification** | Notification | 3 |
| **Reporting** | *(read-only, cross-module queries)* | — |

**Rule (restated from Architecture §6):** every module's data access layer is called only from its own service layer. Cross-module reads/writes go through the owning module's service methods — except Reporting, which reads directly across modules (no write responsibility).

### 1.3 Shared Infrastructure
| Component | Choice | Rationale |
|---|---|---|
| Primary database | PostgreSQL | 🔒 Decision 12; enables RLS, JSONB, native DECIMAL |
| Session/cache store | Redis | 🔒 Decision 12 (queue) extended ✅ to also back sessions, since Decision 3 requires immediate session revocation on deactivation — a Redis-backed session store makes revocation a simple key delete |
| Object storage | S3-compatible | 🔒 Decision 9 |
| Background queue | BullMQ (Redis-backed) | 🔒 Decision 12 |
| Malware scanner | Pluggable interface (`IMalwareScanner`) | 🔒 Decision 10 — provider swappable without touching call sites |
| Email provider | Pluggable interface (`IEmailSender`) | Matches the "replaceable provider" pattern already established for scanning; Frontend Phase 16 wires Postmark as the concrete provider |

### 1.4 External Integrations
None in V1 🔒 (PRD §10, Architecture §13). The only "external" surfaces built now are the two provider interfaces above (scanner, email) — both already anticipated as swappable, not integrations in the PRD's sense (accounting/GPS/load-boards/EDI/webhooks/public API all remain explicitly deferred).

---

## 2. Backend Architecture

### 2.1 API Layer (Controllers)
Thin by design: parse/validate request shape (DTO), resolve `req.context` (userId, organizationId, membershipId, roles — set by auth middleware, §3), call exactly one service method, map the result to a response DTO. **No business logic, no direct DB access, no state-machine logic in controllers.**

### 2.2 Service Layer
One service class per module (§1.2). Every locked workflow **step** (e.g., Workflow 5 §5.4 "Carrier Assignment") maps to exactly one service method (e.g., `LoadService.assignCarrier(loadId, carrierId, rate, ctx)`), so the workflow documents remain directly traceable into code — a reviewer should be able to open `docs/workflows/05-...md` next to `load.service.ts` and match sections to methods one-to-one.

Each service method is responsible for, in order:
1. Load the entity (org-scoped query).
2. Run permission check (if not already covered by a controller-level Guard).
3. Run business validation (state-machine legality, cross-field rules, eligibility gates).
4. Perform the mutation(s) inside a single DB transaction (§2.6).
5. Write the AuditLog entry (and DomainEvent, §9) inside the **same transaction**.
6. Return the updated entity.

### 2.3 Domain Layer (State Machines)
Each stateful entity (Load, Stop, Quote, Document review, CarrierPayment, Invoice) has a small, pure domain module exporting:
- `ALLOWED_TRANSITIONS: Record<Status, Status[]>`
- `assertTransition(current, target): void` — throws `InvalidTransitionError` if illegal.
- Any transition-specific precondition checks (e.g., `assertDispatchGate(load)` checking eligible carrier + rate + Rate Confirmation + driver/truck/trailer all present, per Workflow 6 §6.1).

This isolates the "is this transition legal right now" question from persistence and HTTP concerns entirely — full detail in §6.

### 2.4 Validation
Two layers, deliberately kept separate:
- **Shape validation** (DTO/class-validator, at the controller boundary): types, required fields, format (email, date, decimal precision). Rejects malformed requests before they reach business logic — `400 Bad Request`.
- **Business validation** (service/domain layer): state-machine legality, cross-entity rules (customer status gates, carrier eligibility, self-review prevention, reason-required fields). Rejects requests that are well-formed but not currently allowed — `409 Conflict` (state/eligibility) or `422 Unprocessable Entity` (business-rule validation failure, e.g., missing required reason).

### 2.5 Authorization
Two layers (mirroring §2.4's split), both required:
- **Guard-level** (NestJS Guards, run before the controller method): coarse role checks — "does this role ever have permission to call this endpoint at all" (e.g., only `ADMIN | OPS_MANAGER | DISPATCHER` may call `POST /loads/:id/assign-carrier`). Driven by the Permission Matrix (§7) as a static config, not scattered conditionals.
- **Service-level** (inside the service method, using loaded entity data): fine-grained checks that need the actual record — self-review prevention (reviewer ≠ uploader, Workflow 3 §3.4), ownership (Sales/Booking "own deals," §5.1.7), the zero-Admin-protection rule (Workflow 1 §1.7).

### 2.6 Transaction Boundaries
One DB transaction per state-mutating service method call. Multi-table writes required by a single workflow step (e.g., Workflow 4 §4.7 Quote→Load conversion: create `Load`, update `Quote.status`/`resulting_load_id`, write 2 AuditLog rows) are wrapped in **one** transaction — either the whole step succeeds or none of it does. Read-only endpoints run without an explicit transaction (a single `SELECT`, or `READ COMMITTED` default).

### 2.7 Error Handling
| Error class | HTTP Status | Example |
|---|---|---|
| `ValidationError` | 400 | Missing required field, malformed date |
| `AuthenticationError` | 401 | No/expired session |
| `PermissionError` | 403 | Role lacks permission for this action |
| `NotFoundError` | 404 | Load ID doesn't exist (or isn't in caller's org — see §3.5) |
| `InvalidTransitionError` | 409 | Attempted an illegal state transition |
| `EligibilityError` | 409 | Carrier not assignment-eligible (Workflow 5 §5.3 hard gate) |
| `BusinessRuleError` | 422 | Missing required reason, self-review attempt |
| `InternalError` | 500 | Unexpected — logged with full context, generic message to client |

A global exception filter maps every thrown error to a consistent JSON shape: `{ "error": { "code": "ELIGIBILITY_ERROR", "message": "...", "details": {...} } }`. The frontend's error-state components (UI_UX_DESIGN.md §5.5.3) key off `code`, not message text, so copy changes never break UI logic.

---

## 3. Authentication & Authorization

### 3.1 Global User 🔒 (Decision 1)
Login authenticates against the global `User` table (email + password, bcrypt/argon2 hash). No org context yet at this point.

### 3.2 Session Establishment
1. `POST /auth/login` validates credentials → looks up all `ACTIVE` `OrganizationMembership` rows for that user.
2. If exactly one: session is created with `organizationId` pre-selected.
3. If more than one: session is created in an "org-pending" state; client is prompted to select (UI_UX_DESIGN.md §5.3.3); `POST /auth/select-organization` finalizes it.
4. If zero (e.g., only a `PENDING_VERIFICATION` or `INVITED` membership exists): login succeeds at the identity level but no workspace is available — client shows an appropriate state, not a crash.

Session store: Redis, keyed by session ID (HttpOnly, Secure, SameSite=Lax cookie). Session payload: `{ userId, organizationId, membershipId, roles: Role[] }`.

### 3.3 Organization Switching 🔒 (Decision 1)
`POST /auth/switch-organization` — re-validates an `ACTIVE` membership exists for `(userId, targetOrgId)`, re-issues the session payload with the new context. This is a **full context switch** (Decision 1's "not a partial in-place merge"), never a request-scoped override.

### 3.4 Roles & Permissions
Roles resolved from `MembershipRole` for the session's current `membershipId` — **never** cached across an org switch, never inferred from the global `User`. The five core roles plus the separately-assignable `COMPLIANCE_REVIEWER` role (Workflow 3 §2; DATABASE_DESIGN.md `MembershipRole` enum) are held as a `Role[]` array per membership, supporting the locked multi-role model (Workflow 1 §7).

### 3.5 Tenant Isolation
**Every** request handler resolves `organizationId` from the session **only** — never from a request body/query/path parameter, even if one is present (an `organization_id` field in a request body, if it ever appears, is ignored/rejected, not trusted). A request middleware sets `req.context` once per request; every downstream service call receives `ctx` and every repository query includes `WHERE organization_id = ctx.organizationId` explicitly.

### 3.6 RLS Interaction with Application Authorization
Two independent layers, per Decision 4 — **defense in depth, not either/or**:
1. **Application layer** (authoritative, primary): every query explicitly filters by `organization_id` from `ctx`. This is what the codebase is written and tested against.
2. **Database layer** (RLS, safety net): at the start of each request's DB transaction, execute `SET LOCAL app.current_org_id = '<ctx.organizationId>'`. Every RLS-protected table's policy is `USING (organization_id = current_setting('app.current_org_id')::uuid)`. If the application layer ever has a bug that omits a `WHERE organization_id = ...` clause, RLS still prevents cross-tenant rows from being returned or written.

`User` has no RLS policy (global table, per Decision 1/DATABASE_DESIGN.md §26); access to `User` rows is gated entirely by the application layer joining through `OrganizationMembership` first.

### 3.7 Audit Identity
Every `AuditLog` row's `actor_user_id` = `ctx.userId` (the global identity), `actor_type = HUMAN`, `organization_id = ctx.organizationId` — consistent with Decision 1's "a person's identity is consistent across every organization they've ever acted in, while every audit entry still carries its own organization_id."

---

## 4. Database Implementation

### 4.1 Migrations ✅
**Recommend Prisma** as the ORM/migration tool (🟡 awaiting your confirmation) — chosen for first-class PostgreSQL migration tooling, TypeScript-native generated types (reducing drift between DATABASE_DESIGN.md's field list and application code), and straightforward raw-SQL escape hatches for the RLS policies and row-locking patterns below (Prisma doesn't manage RLS policies natively — those ship as raw SQL migration steps alongside Prisma's schema migrations). Alternative considered: TypeORM (more "batteries included" for NestJS specifically, but weaker migration-diffing story) — noted, not chosen.

Every migration is forward-only in production (no down-migrations relied upon operationally); schema changes are additive where possible to avoid downtime, consistent with Architecture §22's "migrations run as a controlled step before deploy."

### 4.2 Foreign Keys
Every relationship in DATABASE_DESIGN.md becomes a real FK constraint **except**:
- `Document.entity_id` (polymorphic — no single target table; existence + org-match validated in the service layer per Decision 3)
- `AuditLog.entity_id`, `DomainEvent.entity_id` (same reasoning — generic references across every entity type)

All other FKs (Customer→Organization, Load→Customer, Stop→Load, Invoice→Customer, etc.) are enforced at the database level with `ON DELETE RESTRICT` as the default (nothing in the locked workflows ever deletes a parent record that has children — Workflow 1's "no deletion" principle extends in spirit to every entity: deactivate/void/close, never delete).

### 4.3 Indexes
Implemented exactly as listed in DATABASE_DESIGN.md §27 in the initial migration — `organization_id`-leading composite indexes on every RLS-protected table, plus the specific query-pattern indexes already enumerated (Load status/dispatcher/customer/invoiced, Document entity+version, AuditLog entity+actor, etc.).

### 4.4 Constraints
- **Native PostgreSQL `ENUM` types** ✅ for genuinely fixed, locked-closed vocabularies: `Load.status`, `Stop.status`, `Quote.status`, `Invoice.status`, `CarrierPayment.status`, `Document.review_status`, `Document.scan_status`, `Carrier.status`, `Customer.status`, role names. These are enums specifically *because* the locked workflows define a closed, non-extensible set — a DB-level guarantee is valuable and cheap.
- **Lookup tables remain** for `DocumentTypeDefinition` and `ChargeTypeDefinition` (Decision Log D13) — these are explicitly extensible per organization, so a fixed `ENUM` would contradict the locked requirement.
- **Uniqueness constraints:** `(organization_id, mc_number)`, `(organization_id, dot_number)` on Carrier (Workflow 3 §3.2 hard block); `(organization_id, load_number)`, `(organization_id, quote_number)`, `(organization_id, invoice_number)`; `(organization_id, user_id)` on OrganizationMembership; a **partial unique index** on `InvoiceLoad(load_id)` excluding rows whose invoice is `VOID` (implements Workflow 8's one-invoice-per-load rule at the DB level, not just application logic, per DATABASE_DESIGN.md §15's own note).
- **NOT NULL** on every field DATABASE_DESIGN.md doesn't explicitly mark nullable.

### 4.5 Transactions & Concurrency
| Scenario | Mechanism |
|---|---|
| Org-scoped numbering (Load/Quote/Invoice #) | `SELECT current_value FROM organization_sequence WHERE organization_id=$1 AND sequence_type=$2 FOR UPDATE`, increment, format, all inside the same transaction as the record insert — prevents duplicate numbers under concurrent creation |
| Zero-Admin protection (Workflow 1 §1.7) | Re-count active Admin `MembershipRole` rows **inside** the deactivation transaction (not pre-checked and trusted) — closes the race window between two simultaneous deactivation requests |
| Carrier eligibility recalculation (Workflow 3 §3.8) | Recalculated synchronously, inside the same transaction as whatever triggered it (document approval, insurance update, FMCSA record) — never deferred to an async job, since Dispatch needs it correct immediately |
| Carrier assignment eligibility re-check at confirmation (Workflow 5 §5.3) | Re-run inside the assignment transaction, not trusted from an earlier read — "the check re-runs live at the moment of assignment" is now a concrete transactional guarantee |
| General isolation level | PostgreSQL default `READ COMMITTED` is sufficient everywhere else at this scale (100–500 loads/day) — no `SERIALIZABLE` needed |

### 4.6 Row-Level Security
Implemented as raw SQL migrations (outside Prisma's schema DSL) applying the policy pattern from DATABASE_DESIGN.md §26 to every `organization_id`-bearing table. The application's DB connection pool sets `app.current_org_id` per-transaction (§3.6) via a Prisma middleware/interceptor that wraps every request's Prisma Client calls in a `$transaction` beginning with the `SET LOCAL` statement.

### 4.7 Numbering Sequences
Implemented per §4.5 — a single `OrganizationSequence` service method (`getNextNumber(orgId, type, tx)`) used by Load booking, Quote creation, and Invoice Draft creation, always called with the caller's active transaction handle so the row lock and the record insert are atomic together.

### 4.8 Document Relationships
Polymorphic `entity_type`/`entity_id` per Decision 3; a shared `DocumentService.attach(entityType, entityId, ctx)` validates the target entity exists and belongs to `ctx.organizationId` before any document write references it — the one place polymorphic integrity is enforced, called from every module that allows document upload (Load, Stop, Customer, Carrier, Driver, Truck, Trailer, Invoice, CarrierPayment).

### 4.9 Financial Records
✅ **All monetary values use `DECIMAL(12,2)` at the database layer (Decision 6) and a decimal-safe type in the application layer** — standard JavaScript/TypeScript `number` is never used for money anywhere in the codebase (native floating point cannot safely represent currency). Recommend the `decimal.js` library (or Prisma's native `Decimal` type, which wraps it) end-to-end: service layer, DTOs, and API response serialization all carry money as string-formatted decimals, never JSON numbers with fractional imprecision risk.

### 4.10 Audit / Event Persistence
`AuditLog` and `DomainEvent` rows are written **inside the same transaction** as the business change they describe (§2.6) — no eventual-consistency gap, no outbox pattern needed yet (Architecture §13 explicitly defers the outbox pattern until webhooks are actually built, since today's only consumers — Audit itself, Notifications — are in-process).

### 4.11 Schema Issues Discovered in Stage 6 — Resolved

Two gaps surfaced while translating the locked workflows into an implementable API (§5) — both now resolved per your direction, recorded here for traceability:

1. **Multi-stop charge/accessorial attribution — B2 RESOLVED, locked for V1.** `ChargeLineItem` (DATABASE_DESIGN.md §14) gets **no `stop_id` column**. Charges remain load-level only; multi-stop loads do not require per-stop charge attribution in V1, and no UI is built for it (§13 has no per-stop charge allocation screen). **Extensibility preserved:** a future nullable `stop_id` FK is additive (no redesign of `Invoice`/`InvoiceLineItem`/profitability calculations, all of which already operate at the Load level and would be unaffected by a later stop-level refinement).
2. **Custom Document/Charge type creation permission — B3 RESOLVED, locked as Admin-only for V1.** Only `ADMIN` may create/manage rows in `DocumentTypeDefinition` or `ChargeTypeDefinition` (both `organization_id`-scoped, fully audit-logged like every other mutation). Other roles select from the configured type list wherever their existing workflow permission already allows the underlying action — this does **not** change who may add an ordinary accessorial charge to a Load (Decision Log D9's Admin/Ops Manager/Dispatcher/Accounting list is unaffected; D9 governs *using* a charge type, B3 governs *defining* one). No separate permission hierarchy is introduced — "Admin-only" is enforced by the same Guard mechanism as every other admin-scoped action (§2.5), not a new authorization concept.

---

## 5. API Design

All routes are versioned (`/api/v1/...`), REST/resource-oriented per Decision 2. All routes require an authenticated session (§3) and are org-scoped implicitly via `ctx` (§3.5) unless marked otherwise.

### 5.1 Full Resource Surface (summary)

| Resource | Routes | Module |
|---|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `POST /auth/select-organization`, `POST /auth/switch-organization`, `PATCH /auth/me` (profile — §5.6 SH-9) | Identity |
| Users/Memberships | `POST /organizations/:orgId/memberships/invite`, `POST /memberships/:id/resend`, `POST /memberships/:id/cancel`, `POST /memberships/:id/activate`, `POST /memberships/:id/deactivate`, `GET /memberships` | Identity |
| Customers | `POST /customers`, `GET /customers`, `GET /customers/:id`, `PATCH /customers/:id`, `POST /customers/:id/status`, `POST /customers/:id/contacts`, `POST /customers/:id/locations`, `POST /customers/:id/rate-agreements` | Customer |
| Carriers | `POST /carriers`, `GET /carriers`, `GET /carriers/:id`, `PATCH /carriers/:id`, `POST /carriers/:id/documents`, `POST /carriers/:id/documents/:docId/review`, `POST /carriers/:id/insurance`, `POST /carriers/:id/fmcsa-verification`, `POST /carriers/:id/activate`, `POST /carriers/:id/service-areas`, `POST /carriers/:id/drivers`, `POST /carriers/:id/trucks`, `POST /carriers/:id/trailers`, `PATCH /carriers/:id/factoring` | Carrier |
| Quotes | `POST /quotes`, `GET /quotes/:id`, `POST /quotes/:id/mark-lost`, `POST /quotes/:id/convert` | Quote/Load |
| Loads | `POST /loads` (direct booking), `GET /loads`, `GET /loads/:id`, `PATCH /loads/:id` (reference numbers), `POST /loads/:id/begin-sourcing`, `POST /loads/:id/sourcing-attempts`, `POST /loads/:id/assign-carrier`, `POST /loads/:id/carrier-rejected`, `POST /loads/:id/generate-rate-confirmation`, `POST /loads/:id/dispatch`, `PATCH /loads/:id/dispatch`, `POST /loads/:id/stops/:seq/arrival`, `POST /loads/:id/stops/:seq/departure`, `POST /loads/:id/check-calls`, `PATCH /loads/:id/risk-status`, `POST /loads/:id/charges`, `POST /loads/:id/close`, `POST /loads/:id/notes`, `POST /loads/:id/communication-activity` | Quote/Load, Sourcing, Dispatch |
| Documents | `POST /documents` (polymorphic upload), `GET /documents?entityType&entityId`, `GET /documents/:id/download-url` | Document |
| Invoices | `POST /invoices` (Builder — Draft), `GET /invoices`, `GET /invoices/:id`, `POST /invoices/:id/send`, `POST /invoices/:id/payments`, `POST /invoices/:id/adjustments`, `POST /invoices/:id/void`, `GET /loads/ready-to-invoice?customerId` | Billing |
| Carrier Pay | `POST /loads/:id/carrier-payments`, `POST /carrier-payments/:id/submit`, `POST /carrier-payments/:id/approve`, `POST /carrier-payments/:id/reject`, `POST /carrier-payments/:id/mark-paid` | CarrierPay |
| Audit | `GET /audit-log?entityType&entityId`, `GET /audit-log?actorUserId` | Audit |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/mark-all-read` | Notification |
| Reporting | `GET /reports/ar-aging`, `GET /reports/ap-aging`, `GET /dashboard` (role-aware) | Reporting |
| **Search** ✅ B4 RESOLVED | `GET /search?q=` (see §5.4) | Reporting (cross-module, read-only) |
| **Custom Types** ✅ B3 RESOLVED | `POST /document-types`, `PATCH /document-types/:id`, `POST /charge-types`, `PATCH /charge-types/:id` — **Admin only** | Document, Billing |

### 5.2 Detailed Endpoint Specifications

Representative endpoints, one per major state-transition or workflow gate — the pattern shown extends identically to every route in §5.1 not detailed here.

---

**`POST /carriers/:id/assign-to-load`** *(implemented as `POST /loads/:id/assign-carrier` — carrier is a body param)*
- **Purpose:** Workflow 5 §5.4 — assign a carrier to a load.
- **Authorization:** `ADMIN | OPS_MANAGER | DISPATCHER` (Workflow 5 §1).
- **Request:** `{ carrierId: string, carrierRate: string (decimal) }`
- **Response:** `200 { load: LoadDTO }`
- **Validation:** `carrierRate > 0`; `carrierId` exists in org.
- **State transition:** `Load.status: CARRIER_SOURCING → CARRIER_ASSIGNED`.
- **Business gate:** `carrierById(carrierId).assignmentEligible === true`, **re-checked live inside this transaction** — not trusted from an earlier read (Workflow 5 §5.3).
- **Failure cases:** `409 EligibilityError` (ineligible carrier — includes `reasons[]` from `Carrier.ineligibility_reasons`, no override possible); `409 InvalidTransitionError` (load not in `CARRIER_SOURCING`); `404` (carrier/load not found or cross-org).
- **Side effects:** creates `CarrierSourcingAttempt` (outcome=`ASSIGNED`), `ChargeLineItem` (side=CARRIER, type=LINEHAUL), `AuditLog` (`Carrier Assigned`).

---

**`POST /loads/:id/carrier-rejected`**
- **Purpose:** Workflow 5 §5.6 — record a post-assignment carrier rejection.
- **Authorization:** `ADMIN | OPS_MANAGER | DISPATCHER`.
- **Request:** `{ reason: string (required, non-empty) }`
- **Response:** `200 { load: LoadDTO }`
- **Validation:** `reason` required — `422 BusinessRuleError` if blank.
- **State transition:** `Load.status: CARRIER_ASSIGNED → CARRIER_SOURCING`; `Load.assigned_carrier_id`/`carrier_rate` cleared.
- **Side effects:** updates the existing `CarrierSourcingAttempt` row to `outcome=REJECTED_AFTER_ASSIGNMENT` (never deleted — Workflow 5 §5.6's "retain the complete sourcing attempt"), `AuditLog`.
- **No cycle limit** (Workflow 5 §5.6) — this endpoint may be called any number of times across a load's life.

---

**`POST /loads/:id/dispatch`**
- **Purpose:** Workflow 6 §6.1 — the full Dispatch gate + explicit action.
- **Authorization:** `ADMIN | OPS_MANAGER | DISPATCHER`.
- **Request:** `{ driverName: string, driverPhone?: string, truckNumber: string, trailerNumber: string, sourceDriverId?: string, sourceTruckId?: string, sourceTrailerId?: string }`
- **Response:** `200 { load: LoadDTO }`
- **Validation:** all four required fields present.
- **Business gate (re-validated server-side, not trusted from client state):** eligible carrier assigned, carrier rate recorded, Rate Confirmation on file — the **full** Workflow 6 §6.1 gate, re-checked here even though the UI only shows this action once those are already true.
- **State transition:** `Load.status: RATE_CONFIRMATION → DISPATCHED`.
- **Failure cases:** `409 InvalidTransitionError` if gate unmet (lists which condition failed).
- **Side effects:** creates `DispatchRecord` (snapshotted values, not references — Workflow 6 §6.2), `AuditLog` (`Load Dispatched`).

---

**`POST /loads/:id/stops/:seq/arrival`** / **`.../departure`**
- **Purpose:** Workflow 6 §6.4/§6.5.
- **Authorization:** `ADMIN | OPS_MANAGER | DISPATCHER`.
- **Request:** `{ timestamp?: string (ISO 8601, defaults to now) }`
- **Validation:** arrival: target stop `status === PENDING`; departure: target stop `status === ARRIVED` and `timestamp >= stop.actual_arrival`.
- **State transition:** `Stop.status: PENDING → ARRIVED` (arrival) or `ARRIVED → COMPLETED` (departure); **then** the service re-evaluates `Load.status` via the derived-status function (§6.3) — never settable directly by any endpoint.
- **Response:** `200 { stop: StopDTO, load: LoadDTO }` (load included since its status may have just changed).
- **Failure cases:** `409` if stop not in the expected prerequisite state; `422` if departure timestamp precedes arrival.

---

**`POST /carriers/:id/documents/:docId/review`**
- **Purpose:** Workflow 3 §3.4 — compliance document Approve/Reject.
- **Authorization:** Requires `COMPLIANCE_REVIEWER` role specifically (not implied by `ADMIN`/`OPS_MANAGER` alone — that role must be separately held per membership, §3.4).
- **Request:** `{ decision: 'APPROVED' | 'REJECTED', rejectionReason?: string }`
- **Validation:** `rejectionReason` required if `decision === 'REJECTED'`.
- **Business gate:** `document.uploaded_by !== ctx.userId` — **self-review prevention**, enforced server-side regardless of what the UI shows/hides (`403 PermissionError`, distinct code `SELF_REVIEW_FORBIDDEN`).
- **State transition:** `Document.review_status: PENDING_REVIEW → APPROVED | REJECTED`.
- **Side effects:** recalculates `Carrier.assignment_eligible` (§6.5) inside the same transaction; `AuditLog`.

---

**`POST /carriers/:id/activate`**
- **Purpose:** Workflow 3 §3.7.
- **Authorization:** `COMPLIANCE_REVIEWER`.
- **Validation/gate:** all 7 eligibility conditions (§6.5) must currently be true — re-evaluated server-side, not trusted from the client's last-seen eligibility badge.
- **State transition:** `Carrier.status: PENDING → ACTIVE`; `assignment_eligible` recalculated (will become `true` as a consequence, not set directly).
- **Failure case:** `409 EligibilityError` listing unmet conditions — activation is **never automatic**, this endpoint is the only path to `ACTIVE`.

---

**`POST /invoices`** *(Invoice Builder — Draft creation)*
- **Purpose:** Workflow 8 §8.1–8.5.
- **Authorization:** `ADMIN | ACCOUNTING` only (Workflow 8's literal actor list — **not** `OPS_MANAGER`, per the §5.4.7 resolution that visibility ≠ action permission).
- **Request:** `{ customerId: string, loadIds: string[], podWarningAcknowledged?: boolean }`
- **Validation:** all `loadIds` share `customerId`; all are `status IN (DELIVERED, CLOSED)` and `invoiced = false`; if any has `pod_status !== COMPLETE`, request must include `podWarningAcknowledged: true` or the API returns `409 { code: 'POD_INCOMPLETE_WARNING', affectedLoads: [...] }` for the client to re-submit with acknowledgment (this is the server-side backbone of the Workflow 8 §8.2 modal).
- **Response:** `201 { invoice: InvoiceDTO }`
- **Side effects:** generates invoice number (§4.7), creates `InvoiceLoad`/`InvoiceLineItem` rows (shape depends on 1 vs. N loads, Workflow 8 §8.5), sets `Load.invoiced = true` on each, `AuditLog` (`Invoice Created — Individual/Consolidated`, plus `Invoice Created Despite Incomplete POD` if acknowledged).

---

**`POST /invoices/:id/send`**
- **Authorization:** `ADMIN | ACCOUNTING`.
- **Request:** `{ recipientEmail: string, subject: string, message: string }`
- **Validation:** invoice `status === DRAFT`.
- **State transition:** `DRAFT → SENT`; `due_date = now + customer.payment_terms` (computed server-side at send time, never client-supplied — Workflow 8 §8.8).
- **Side effects:** queues a transactional email job (§10); `AuditLog` (`Invoice Sent`).

---

**`POST /carrier-payments/:id/approve`** / **`.../reject`**
- **Purpose:** Workflow 9 §9.4.
- **Authorization:** `ADMIN` only (Workflow 9 §2 — "Approval authority: Admin only").
- **Business gate:** `payment.prepared_by !== ctx.userId` (self-approval prevention, `403 SELF_REVIEW_FORBIDDEN`); approve does **not** accept an amount field — the submitted amount is immutable at this step (Workflow 9 §9.4's "reject to revise, never amend on approval").
- **State transition:** `PENDING_APPROVAL → APPROVED` or `PENDING_APPROVAL → DRAFT` (reject, reason required).

---

**`POST /loads/:id/close`**
- **Purpose:** Workflow 10.
- **Authorization:** `ADMIN | OPS_MANAGER | ACCOUNTING` (Workflow 10 §1 — note **not** `DISPATCHER`, matching the §5.4.8 permission gate bug caught and fixed during the prototype build).
- **Validation:** `Load.status !== CLOSED` — this is the **only** precondition (Workflow 10 §10.9's exact resolution — no `DELIVERED` requirement).
- **Never returns a validation failure for an incomplete checklist** — the checklist is informational (computed and returned in the response), the action itself is unconditional once the one precondition above is met.
- **Response:** `200 { load: LoadDTO, checklistSnapshot: ChecklistItem[] }`
- **Side effects:** `Load.status → CLOSED`; `AuditLog` (`Load Closed`, `new_value` = full checklist snapshot per Workflow 10 §10.7).

---

### 5.3 Response Conventions
- Money fields serialize as **decimal strings** (`"2450.00"`), never JSON numbers (§4.9).
- List endpoints (`GET /loads`, etc.) support `?page`, `?pageSize`, and the filter query params matching UI_UX_DESIGN.md §5.4.1's filter set; filters combine with AND across fields, OR within a multi-value field (§5.5.11 recommendation, now made a real API contract).
- Every response DTO is **permission-shaped at serialization time** — e.g., `LoadDTO` for a `DISPATCHER` session literally omits `customerRate`/`carrierRate`/`margin` fields rather than nulling them, so there's no client-side "hide this field" logic standing between the API and what's displayed (mirrors §5.5.5's hide-not-disable principle at the data layer, not just the UI layer).

### 5.4 Global Search — B4 Resolution ✅

**`GET /search?q=<term>`**
- **Purpose:** backs the `⌘K` command-palette overlay (UI_UX_DESIGN.md §5.3.6) and the Dispatch Board's in-page search.
- **Authorization:** any authenticated session; results are filtered, not the endpoint itself.
- **Implementation:** a single server-side endpoint querying Load/Customer/Carrier/Invoice tables directly — the entities UI_UX_DESIGN.md's global search interaction actually requires (§5.3.6: "Loads, Customers, Carriers, Invoices"). **No dedicated search engine** (Elasticsearch/OpenSearch/etc.) for V1 — plain indexed Postgres queries are sufficient at the locked target scale (100–500 loads/day, PRD §1.3). Matching strategy: `ILIKE '%term%'` against a small indexed column set per entity (Load #, Customer/Carrier name, Invoice #) to start; upgrade to a `pg_trgm` trigram index if `ILIKE` scan performance ever becomes a measured problem — **no premature optimization**, consistent with the PRD's explicit "don't over-build for scale not yet demonstrated" instruction (§1.3).
- **Tenant isolation & RLS:** identical to every other query — explicit `organization_id` filter (§3.5) plus RLS as the safety net (§3.6). Search never becomes a second code path that bypasses either.
- **Financial visibility:** search results apply the **exact same field-shaping rules as every other endpoint** (§5.3's permission-shaped DTOs) — a Dispatcher's search results for a Load never include rate/margin fields; a Sales/Booking user's results are limited to their own-deal financial data per the ownership rule (§5.1.7), identical to the Dispatch Board and every other screen. Search is not a separate permission surface with its own rules.
- **Response shape:** `{ loads: LoadSummaryDTO[], customers: CustomerSummaryDTO[], carriers: CarrierSummaryDTO[], invoices: InvoiceSummaryDTO[] }`, each array capped (e.g., top 5) per UI_UX_DESIGN.md §5.3.6's "up to 5 matches per group + See all results."
- **Replaceability:** the endpoint's internal query implementation is isolated behind the Reporting module's search service method — swapping in a dedicated search index later (if the scale assumption above is ever exceeded) changes that one method's internals, not the API contract or any caller.

---

## 6. State Machines

Every state machine below is a direct, non-reinterpreted implementation of its locked workflow. Enforcement lives in the domain layer (§2.3), called from the service layer before any mutation.

### 6.1 Load
```
BOOKED → CARRIER_SOURCING → CARRIER_ASSIGNED → RATE_CONFIRMATION → DISPATCHED → PICKUP → IN_TRANSIT → DELIVERED → [CLOSED]
                                    ↑_______________|  (Carrier Rejected)
```
| Transition | Trigger | Actor | Required Data | Kind |
|---|---|---|---|---|
| `(none)→BOOKED` | Direct booking or Quote conversion | Admin/OpsMgr/Dispatcher/Sales | ≥1 pickup + ≥1 delivery stop, equipment, customer rate | Manual |
| `BOOKED→CARRIER_SOURCING` | Begin Sourcing | Admin/OpsMgr/Dispatcher | — | Manual (direct) |
| `CARRIER_SOURCING→CARRIER_ASSIGNED` | Assign Carrier | Admin/OpsMgr/Dispatcher | Eligible carrier, rate | Manual (assisted) |
| `CARRIER_ASSIGNED→CARRIER_SOURCING` | Carrier Rejected | Admin/OpsMgr/Dispatcher | Reason | Manual (assisted) |
| `CARRIER_ASSIGNED→RATE_CONFIRMATION` | Generate Rate Confirmation | Admin/OpsMgr/Dispatcher | — (carrier+rate already present) | Manual (assisted) |
| `RATE_CONFIRMATION→DISPATCHED` | Dispatch Load | Admin/OpsMgr/Dispatcher | Driver, phone, truck, trailer | Manual (assisted) |
| `DISPATCHED→PICKUP` | *(none — derived)* | System | First pickup Stop reaches `ARRIVED` | **System-derived** |
| `PICKUP→IN_TRANSIT` | *(none — derived)* | System | **All** pickup Stops reach `COMPLETED` | **System-derived** |
| `IN_TRANSIT→DELIVERED` | *(none — derived)* | System | **Final** (by sequence) delivery Stop reaches `COMPLETED` | **System-derived** |
| `[any]→CLOSED` | Close Load | Admin/OpsMgr/Accounting | Not already Closed | Manual (no other precondition) |

`pod_status` (`NOT_RECEIVED`/`PARTIAL`/`COMPLETE`) is a **milestone/flag**, not part of this state machine — derived independently from delivery-Stop document presence (§6.4), displayed alongside `status` but never gating or gated by it (Workflow 7 §7.2, 10 §10.5).

### 6.2 Stop
`PENDING → ARRIVED → COMPLETED`. Manual, triggered by Record Arrival/Record Departure endpoints. No sequence-order enforcement on *data entry* (any pending stop's arrival may be recorded regardless of other stops' state) — only the **Load**-level derived transitions above care about sequence/completeness.

### 6.3 Load-Status Derivation Function
```
function deriveLoadStatus(load, stops):
  if load.status not in {DISPATCHED, PICKUP, IN_TRANSIT}: return load.status  // not applicable
  pickups = stops.filter(type=PICKUP)
  deliveries = stops.filter(type=DELIVERY).sortBy(seq)
  finalDelivery = deliveries.last()
  if finalDelivery.status == COMPLETED and pickups.every(COMPLETED): return DELIVERED
  if pickups.every(COMPLETED): return IN_TRANSIT
  if pickups.any(status != PENDING): return PICKUP
  return load.status  // unchanged
```
Called after every `arrival`/`departure` endpoint call, inside the same transaction. **No endpoint ever accepts `Load.status` as a directly-settable field for these three values** — this is the concrete enforcement of Workflow 6 §6.6's "cannot be manually set ahead of what stop progress supports."

### 6.4 POD Milestone Derivation
```
function derivePodStatus(load):
  deliveryStops = load.stops.filter(type=DELIVERY)
  withDocs = deliveryStops.filter(hasApprovedPodDocument)
  if withDocs.length == 0: return NOT_RECEIVED
  if withDocs.length < deliveryStops.length: return PARTIAL
  return COMPLETE
```
Recalculated on every POD document upload/removal (Workflow 7 §7.2), persisted per Decision 5 (high-read field).

### 6.5 Carrier Assignment Eligibility
```
function computeEligibility(carrier):
  reasons = []
  if carrier.status == BLOCKED: reasons.push("Carrier is Blocked")
  if carrier.status != ACTIVE: reasons.push("Carrier status is not Active")
  if carrierAgreement.review_status != APPROVED: reasons.push(...)
  if w9.review_status != APPROVED: reasons.push(...)
  if autoLiability.expiration < today or autoLiability.coiDocStatus != APPROVED: reasons.push(...)
  if cargo.expiration < today or cargo.coiDocStatus != APPROVED: reasons.push(...)
  if mcAuthority.review_status != APPROVED: reasons.push(...)
  if fmcsaVerification == null or not acceptable: reasons.push(...)
  return { eligible: reasons.length == 0, reasons }
```
Recalculated synchronously inside the same transaction as any input change (§4.5) — **never** by a background job for the purposes of blocking/allowing assignment (a background job *does* run daily to catch pure time-based expiration with no other trigger, §10). `Carrier.status` and `assignment_eligible` remain fully independent fields (Workflow 3 §3.8/§3.12) — a `BLOCKED` carrier is always ineligible regardless of the other six conditions.

### 6.6 Quote
`OPEN → WON | LOST` — both terminal, **no transitions out of either** (Workflow 4 §4.6, locked as permanently terminal). `WON` is system-set only, as a side effect of successful conversion (§Load `(none)→BOOKED` above with `booking_source=QUOTE`); `LOST` is set by explicit user action (reason required) or the automatic expiration sweep (§10).

### 6.7 Document Review
`(upload) → PENDING_REVIEW → APPROVED | REJECTED`, plus time-based `→ EXPIRED` (background job, §10). Applies only to `DocumentTypeDefinition` rows with `requires_review = true` (the four carrier compliance types) — all other document types (POD, BOL, Rate Confirmation, receipts) have `review_status = NOT_APPLICABLE` and never enter this machine.

### 6.8 Carrier Payment
`DRAFT → PENDING_APPROVAL → APPROVED → PAID`, with `PENDING_APPROVAL → DRAFT` on rejection (Workflow 9 §9.4–9.5). No `REJECTED` terminal state — rejection is a **loop back**, not a dead end, and may cycle any number of times.

### 6.9 Invoice
`DRAFT → SENT → PARTIALLY_PAID → PAID`, with `VOID` reachable from any pre-Void status and `CREDITED` reachable from `SENT/PARTIALLY_PAID/OVERDUE` when fully offset by adjustments. `PARTIALLY_PAID`/`PAID` are **derived** from `remaining_balance` (§4.9) after each Payment/Adjustment write, never set directly. `OVERDUE` is **not a stored state at all** — computed at read/query time (`status IN (SENT,PARTIALLY_PAID) AND due_date < now() AND remaining_balance > 0`), per Decision 5 and Workflow 8 §8.10's explicit "no scheduled recalculation job."

---

## 7. Permissions Matrix

Legend: **V**=Visibility, **C**=Create, **E**=Edit, **A**=Approve, **S**=Send, **P**=Pay, **X**=Close, **Admin**=administrative action. A blank cell means no access of any kind — visibility does not imply any action, per your instruction.

| Action | Admin | Ops Mgr | Dispatcher | Sales/Booking | Accounting |
|---|:---:|:---:|:---:|:---:|:---:|
| **Org/User** | | | | | |
| Invite/deactivate users, manage roles | Admin | | | | |
| Edit own profile (name/password) | E | E | E | E | E |
| **Customer** | | | | | |
| View | V | V | V | V | V |
| Create / Edit / Change Status | C,E | C,E | | C,E | C,E |
| Add Contact/Location/Rate Agreement | C | C | | C | C |
| **Carrier** | | | | | |
| View | V | V | V | V | V |
| Create / Edit | C,E | C,E | C,E | | |
| Upload compliance/insurance docs | C | C | C | | |
| Approve/Reject docs, Record FMCSA, Activate | *only with Compliance Reviewer role* | *only with Compliance Reviewer role* | *only with Compliance Reviewer role* | | |
| **Quote/Load** | | | | | |
| View (financial fields per ownership/role) | V | V | V (no $) | V (own deals $) | V |
| Create Quote / Direct Booking | C | C | C | C | |
| Begin Sourcing / Assign Carrier / Carrier Rejected | E | E | E | | |
| Generate Rate Confirmation / Dispatch | E | E | E | | |
| Record Arrival/Departure, Check Calls, Risk Status | E | E | E | | |
| Add Charge (D9 — using an existing charge type) | C | C | C | | C |
| **Documents** | | | | | |
| Upload (Load-level, incl. POD) | C | C | C | *(entity-access dependent)* | C |
| **Custom Types (B3)** | | | | | |
| Create/Edit custom Document Type or Charge Type definitions | Admin only | | | | |
| **Financials** | | | | | |
| View Load financials/margin | V | V | | V (own, no margin) | V |
| Create/Send Invoice, Record Payment, Adjust, Void | | | | | C,E,S,Admin |
| Create/Approve Carrier Payment | *submit only* | | | | *submit only* |
| Approve Carrier Payment | Admin only | | | | |
| **Load Closing** | | | | | |
| View checklist / Close | X | X | | | X |
| **Reporting** | | | | | |
| AR/AP aging, financial reports | V | V | *(ops reports only)* | *(sales reports only)* | V |

**Cross-cutting notes, restated for implementation precision:**
- "Visibility" in this matrix never implies "Create/Edit/Approve/Send/Pay/Close" — each is checked independently in the Guard/service layer (§2.5); this table's blank cells are the authoritative list of what to leave **unimplemented as an action** for that role, not just hidden in the UI.
- `COMPLIANCE_REVIEWER` is a separately assignable role (§3.4) layered on top of the five above, not a sixth mutually-exclusive role — a user can hold e.g. `ADMIN + COMPLIANCE_REVIEWER` simultaneously.
- Operations Manager's Invoice row is intentionally **view-only with zero actions** — confirmed in §5.4.7's resolution as the literal reading of Workflow 8's actor list, not extended based on general financial-visibility parity.
- **D9 vs. B3, kept distinct:** *using* an existing charge type to add a charge to a Load (D9 — Admin/Ops Manager/Dispatcher/Accounting) and *defining* a new custom charge or document type for the organization (B3 — Admin only) are two different permissions governing two different actions. Nothing about B3 narrows D9.

---

## 8. Documents & File Processing

### 8.1 Upload Flow
```
1. Client → POST /documents (multipart or presigned-URL pattern — 🟡 recommend presigned S3 PUT
   to avoid proxying large files through the API server; API issues a short-lived presigned URL,
   client uploads directly to S3, then confirms via POST /documents/:id/confirm)
2. API creates Document row: scan_status=PENDING, is_current_version=true, storage_key=
   `org_{organizationId}/documents/{uuid}`
3. API enqueues a malware-scan job (BullMQ) — async, off the request path (§10)
4. Worker calls IMalwareScanner.scan(storageKey) → { status: CLEAN | INFECTED | SCAN_FAILED, provider }
5. Worker updates Document.scan_status; if INFECTED/SCAN_FAILED, the object is moved to a
   `org_{organizationId}/quarantine/{uuid}` prefix (bucket policy denies any signed-URL
   generation for quarantine-prefixed keys, as a second enforcement layer beyond the
   scan_status check)
6. AuditLog entry written for the scan result
```

### 8.2 Scanner Interface (Decision 10)
```typescript
interface IMalwareScanner {
  scan(storageKey: string): Promise<{ status: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'; provider: string }>;
}
```
Frontend Phase 16 — Cloudmersive is wired as the concrete provider (`CloudmersiveMalwareScanner`), satisfying this interface without touching `DocumentService` or any call site, exactly as anticipated here.

### 8.3 Versioning
`document_family_id` (stable across versions) + `version_number` + `is_current_version` (Decision Log D4). A new upload against an existing family creates a new row, sets the previous `is_current_version=false`, never overwrites or deletes prior rows.

### 8.4 Access Control & Download
`GET /documents/:id/download-url` — service layer checks (a) the requester's permission to view the parent entity (document visibility = entity access, PRD's rule) and (b) `scan_status === 'CLEAN'`; only then generates a **time-limited signed URL** (recommend 5-minute expiry) directly to S3. No document is ever served through the API server's own response body (avoids the API process handling large file bytes).

### 8.5 Compliance Review State
Only `DocumentTypeDefinition.requires_review = true` types (W9, COI, Carrier Agreement, MC Authority) carry a meaningful `review_status`; all other types default to `NOT_APPLICABLE` and skip the review endpoint entirely — enforced by the API rejecting a `POST .../review` call against a non-reviewable document type (`400`).

---

## 9. Audit & Domain Events

### 9.1 Domain Event List
Every named audit action across Workflows 1–10 (~60 distinct events, e.g., `LoadDispatched`, `CarrierAssigned`, `InvoicePaid`, `ComplianceDocumentApproved`) is emitted as a `DomainEvent` row **and** an `AuditLog` row, written transactionally together (§4.10) by the same service-layer call — not two independent writes that could drift.

### 9.2 Actor & Context
`actor_user_id` + `actor_type` (`HUMAN`/`SYSTEM`/`AI` — Decision 8) + `organization_id`, resolved from `ctx` (§3.7) for human-triggered events, or a `SYSTEM` sentinel for background-job-triggered ones (expiration sweeps, derived-status recalculation with no direct human trigger in that instant).

### 9.3 Correlation / Request IDs ✅ (Stage 6 addition)
Every inbound API request is assigned a `requestId` (UUID, generated at the edge middleware) propagated through `ctx` into every `AuditLog`/`DomainEvent` row written during that request (`correlation_id` column — a small, additive field not explicitly named in DATABASE_DESIGN.md, called out here as a Stage 6 refinement). This lets support/debugging trace "everything that happened as a result of this one API call" without inferring it from timestamps — cheap to add now, painful to retrofit. Flagged in §17 as ✅ rather than 🔴 since it doesn't change any locked schema decision, only adds one column to an already-flexible JSONB-backed table.

### 9.4 Before/After Values
Per Decision 7/Decision Log D15: field-level diffs for edits, full-entity snapshots for creation/major-transition events, both as `previous_value`/`new_value` JSONB.

### 9.5 Financial Redaction
Implemented **once**, centrally, in the `AuditLog` read-side serializer — not per-caller. Given a requester's resolved roles (§3.4) and the entry's `entity_type`, a redaction rule set strips known financial keys (`amount`, `rate`, `customerRate`, `carrierRate`, `margin`, etc.) from `previous_value`/`new_value`/the human-readable `detail` string before the API response is built, for `DISPATCHER` sessions and for `SALES` sessions viewing entries outside their own deals. **The stored row is never modified** — this is a read-time projection, satisfying the §5.4.4 LD-6 requirement precisely ("redaction must occur at the presentation/API authorization layer, not by deleting or altering the underlying audit record").

### 9.6 Notifications as an Event Subscriber
The `Notification` module subscribes to a small, explicit allow-list of `DomainEvent` types (currently only `ComplianceExpiring30/15/7Day`, per Workflow 3 §3.10 — the only concrete V1 notification type) and writes a `Notification` row per matching event. Adding a future notification type is "add an event type to the subscriber's allow-list," never a change to the emitting module.

### 9.7 Future Webhooks/AI Consumption
Both remain **deferred, not built** — noted here only to confirm the event backbone above is already the correct foundation: a future webhook dispatcher and a future AI action-logger would both be additional subscribers to the same `DomainEvent` stream, with no changes required to any of the ~13 modules that emit events today (Architecture §13/§15).

---

## 10. Background Jobs

| Job | Trigger | Cadence | Source |
|---|---|---|---|
| Invitation expiration sweep | Scheduled | Daily | Workflow 1 §1.6 |
| Quote expiration sweep | Scheduled | Daily | Workflow 4 §4.5 |
| Carrier compliance/insurance expiration sweep (sets `Expired` status, recalculates eligibility) | Scheduled | Daily | Workflow 3 §3.9 |
| Expiration notification thresholds (30/15/7 days) | Scheduled | Daily | Workflow 3 §3.10 |
| Malware scan | Event (on upload) | Async, immediate | Decision 10 |
| Transactional email send (Rate Confirmation, Invoice) | Event (on Send action) | Async, immediate | PRD §10.1 |
| Document/PDF generation (Rate Confirmation, Invoice, Settlement) | Event (on Generate action) | Async, immediate | Workflows 5, 8, 9 |
| **Check-call reminder sweep** ✅ B1 RESOLVED | Scheduled | Fixed system interval (see below) | PRD §Tracking/§6.7 |

### 10.1 Check-Call Reminder Sweep — B1 Resolution ✅
**Locked for V1:** a simple, **fixed, non-configurable** system cadence — not the "organization/lane/customer-configurable" engine the PRD's §15 ambiguity #8 originally contemplated. The job scans all Loads with `status IN (DISPATCHED, PICKUP, IN_TRANSIT)`, and for any load whose most recent `CheckCall.at` (or `DispatchRecord.dispatched_at` if no check call has been logged yet) is older than the fixed interval, generates a `CheckCallOverdue` domain event → one `Notification` to the load's assigned dispatcher, via the exact same event-subscriber mechanism as every other notification (§9.6). No new notification *type* or delivery channel is introduced — this is the PRD's check-call reminder requirement and nothing more.

**Architecturally extensible, not built now:** the interval is read from a single system-wide constant, not a database column — but the sweep function takes the interval as a parameter, so a future `Organization.check_call_cadence_hours` (or a per-lane/customer override) is a config-source change only, never a rewrite of the sweep logic itself.

**🟡 Exact interval — small remaining business decision, not blocking:** no source document specifies the number of hours. Recommend **4 hours**, matching the same 4-hour granularity already used elsewhere in the locked product for time-sensitive operational windows (PRD's "Pickups next 4h" quick filter, §5.4.1). This is a proposal, not a silently-locked business rule — confirm or override before Stage 7 hardcodes it.

**Explicitly NOT built**, called out to prevent Stage 7 over-building:
- **Invoice `OVERDUE` recalculation job** — computed at read time only (§6.9, Decision 5, Workflow 8 §8.10's explicit instruction).
- Any job not explicitly named above (no speculative "might be useful" jobs), per your instruction.

---

## 11. Security

| Concern | Approach |
|---|---|
| **Tenant isolation** | Two-layer: application-layer explicit `organization_id` filtering (authoritative) + PostgreSQL RLS (defense-in-depth), per §3.6 |
| **Authorization** | Guard-level (coarse, role-based) + service-level (fine-grained, entity-aware) per §2.5, driven by the §7 matrix as config, not scattered conditionals |
| **Object storage access** | No public buckets; org-scoped key prefixes (Decision 9); all downloads via short-lived signed URLs issued only after a permission + `scan_status=CLEAN` check (§8.4) |
| **File scanning** | Mandatory async scan before any document is downloadable; infected/failed files quarantined to a separate, policy-denied prefix (§8.1) |
| **Secrets** | Environment-injected (or a secrets manager, per hosting choice in Stage 6/22) — never committed to the repository; DB credentials, session secret, S3 keys, scanner/email provider credentials all externalized |
| **Password handling** | bcrypt or argon2 hashing (Architecture §3); no plaintext password ever logged or stored; verification/invitation tokens stored hashed, single-use, time-limited (Workflow 1) |
| **Session security** | HttpOnly + Secure + SameSite=Lax cookies; Redis-backed for immediate revocation (Decision 3); session fixation prevented by regenerating session ID on login |
| **API security** | HTTPS/TLS only; rate limiting on `/auth/login` (🟡 recommend a standard sliding-window limiter, e.g., 10 attempts/15min per IP+email, to blunt credential stuffing — not specified in any prior document, a reasonable default); CSRF protection appropriate to cookie-based sessions (double-submit token or `SameSite=Lax` + custom header requirement on mutating requests) |
| **Input validation** | DTO-level shape validation on every endpoint (§2.4); parameterized queries/ORM exclusively — no raw string-concatenated SQL anywhere |
| **XSS** | React's default output escaping; a Content-Security-Policy header restricting script sources, since the frontend renders user-supplied text (customer names, notes, etc.) extensively |
| **Audit integrity** | `AuditLog`/`DomainEvent` are **append-only** at the database grant level — the application's normal DB role has `INSERT`+`SELECT` only on these two tables, no `UPDATE`/`DELETE` grant at all, so even a application-layer bug cannot silently alter history |
| **Dependency hygiene** | Automated dependency vulnerability scanning in CI (🟡 tool choice deferred to Stage 7 tooling setup) |

### 11.1 OWASP Top 10 Mapping (abbreviated)
| Risk | Mitigation |
|---|---|
| Injection | ORM/parameterized queries exclusively |
| Broken Authentication | Redis sessions, bcrypt/argon2, rate-limited login, immediate revocation on deactivation |
| Sensitive Data Exposure | TLS in transit, encryption at rest (DB + object storage), financial redaction at the presentation layer (§9.5) |
| Broken Access Control | Two-layer authorization (§2.5) + RLS (§3.6) |
| Security Misconfiguration | Environment-based config, no default credentials, CSP headers |
| XSS | React escaping + CSP |
| Insecure Deserialization | N/A at this architecture's scope (no untrusted deserialization of complex objects) |
| Using Components with Known Vulnerabilities | CI dependency scanning 🟡 |
| Insufficient Logging & Monitoring | Structured application logs + the universal AuditLog (§9) + correlation IDs (§9.3) |

---

## 12. Reliability & Operations

### 12.1 Operational Targets 🔒 (Decision 11) — **stated explicitly as internal targets, not a vendor SLA guarantee**
- **RPO ≤ 24 hours** — automated backups (or continuous WAL archiving) at least daily; a managed PostgreSQL provider with point-in-time recovery comfortably exceeds this.
- **RTO ≤ 4 hours** — restore/failover tooling and process must be demonstrably capable of completing within this window; requires a documented, periodically-tested restore runbook (Stage 7/deployment deliverable, not written here).
- **Backup retention ≥ 30 days.**

These are targets this architecture is designed to support — actual achievement depends on the hosting provider selected in Stage 7/deployment planning, which is why they're not phrased as guarantees here.

### 12.2 Logging & Monitoring
- Structured JSON application logs (distinct from the business `AuditLog`, per Architecture §19), tagged with `requestId` (§9.3) for cross-referencing a log line back to its audit trail.
- Centralized log aggregation and error tracking (🟡 tool choice deferred).
- **Health check endpoint** (`GET /health`) verifying DB connectivity, Redis connectivity, and queue worker liveness.
- **Job-queue monitoring** — queue depth and failure-rate alerting, called out as important because several locked business behaviors (compliance expiration, quote expiration) silently depend on the scheduler actually running (Architecture §19's specific warning).

### 12.3 Backups & Restore
Automated daily-minimum backups meeting §12.1; restore procedure documented and periodically drilled (not a one-time setup) — a Stage 7/operations deliverable.

### 12.4 Failure Handling
- Background jobs (§10) use retry-with-backoff (BullMQ's built-in retry policies) for transient failures (e.g., a scanner provider timeout); a job that exhausts retries lands in a dead-letter state visible to monitoring, not silently dropped.
- API-level failures return the typed error shapes from §2.7 — no failure mode should surface a raw stack trace or generic 500 to the client without also being logged with full context server-side.

### 12.5 Deployment Considerations
Three-environment model (dev/staging/production), containerized (Docker), migrations run as a controlled pre-deploy step, rolling/blue-green deployment to avoid downtime during business hours (Architecture §22) — full detail remains a Stage 7 deployment-configuration task, intentionally not specified further here per the "no deployment configuration yet" constraint.

---

## 13. Frontend Architecture

### 13.1 Routing
React Router, routes mapped 1:1 to the UI_UX_DESIGN.md §5.1.4 sitemap — no new routes invented, no locked routes dropped. Route guards check the same permission matrix (§7) client-side for UI purposes only; **the backend remains the sole authority** (§2.5) — a client-side guard failing open is a UX bug, not a security hole, since the API independently enforces everything.

### 13.2 Page & Component Structure
Mirrors the prototype's screen breakdown exactly (8 critical screens + supporting list screens), now built as real React components instead of template-literal HTML strings:
- **Design tokens** (§5.2.1–5.2.3): ported verbatim as CSS custom properties / a theme object — colors, type scale, spacing, radius, shadow — no new tokens invented.
- **Shared primitives**: `Button`, `Badge` (with the exact status-color mapping table from §5.2.1/§5.4 baked in as a lookup, not re-derived per screen), `DataTable` (sortable/filterable, frozen-column pattern from §5.4.1), `Drawer`, `Modal` (backdrop-block variant per §5.5.7), `Toast`, `Tabs`, `Stepper` (Load Detail's lifecycle visualization), `ChecklistItem` (Load Closing).
- **Forms**: React Hook Form + a schema validator (zod) whose schemas mirror the backend DTOs field-for-field, so client-side validation messages never diverge from what the API will actually accept/reject.

### 13.3 State Management
- **Server state**: TanStack Query (React Query) — request caching, invalidation on mutation, background refetch; every screen's data-loading is a query keyed by resource + filters, matching §5.5.11's URL-persisted-filter recommendation (query params double as both the browser URL state and the query cache key).
- **Client/UI state**: component-local state for ephemeral UI (open modal, active tab, selected rows); a small global store (Zustand or React Context) only for genuinely cross-cutting session data — current user, current organization, resolved roles (replacing the prototype's role-simulator dropdown with the real authenticated session).
- **Permissions hook**: `usePermissions()` derives allowed actions from the session's roles against the same matrix config as the backend Guards (§7) — kept as a single source of truth (a shared package/constants file imported by both frontend and backend where the monorepo structure allows, avoiding the two ever drifting silently).

### 13.4 API Data Fetching
One typed API client module per backend module (§1.2), generated or hand-written against the DTO shapes in §5 — every network call goes through this layer, never ad hoc `fetch()` calls scattered through components.

### 13.5 Loading / Error / Empty States
Implements §5.5.1–5.5.3 exactly: skeleton components matching each screen's dominant shape, tab-scoped error boundaries on multi-tab detail screens, the three empty-state variants (§5.5.2), and the still-open-but-now-resolved SH-11 Dashboard "Getting Started" guide (§5.6).

### 13.6 Accessibility
Focus trapping in modals, Escape-to-close (§5.5.7), visible (not hover-only) kebab menu triggers (§5.5.13), and the two keyboard-accessible alternatives now wired to **real** endpoints rather than mock functions:
- **Kanban `Move to…`**: calls the identical backend endpoint (`POST /loads/:id/assign-carrier`, `.../dispatch`, etc.) as the drag-and-drop handler — one API call per transition, two UI entry points, exactly as the prototype demonstrated and §5.5.13/INT-13 locked.
- **Calendar `Reschedule`**: calls a dedicated `PATCH /loads/:id/stops/:seq` (appointment-only) endpoint — not yet listed in §5.1's summary table, added here: **`PATCH /loads/:id/stops/:seq`** — `{ appointmentDatetime: string }`, `ADMIN|OPS_MANAGER|DISPATCHER`, updates only `Stop.appointment_datetime`, never `status`, fully audited (previous/new datetime + actor) per Workflow 6/§5.6 INT-13.

---

## 14. Prototype → Production Gap Analysis

| Area | Prototype (Stage 5.7) | Production Requirement |
|---|---|---|
| **Data persistence** | In-memory JS objects, reset on page reload | PostgreSQL via the full schema in DATABASE_DESIGN.md, migrations, RLS |
| **Authentication** | None — role selected via a labeled dropdown | Real session-based auth (§3), email verification, invitation tokens |
| **Authorization** | Client-side conditionals mirroring the permission matrix | Server-side Guards + service-level checks (§2.5/§7) as the actual enforcement point; client-side becomes UX-only |
| **API layer** | None — all "business logic" is inline JS in the HTML file | Full REST API per §5, with real validation/transactions/error handling |
| **State machines** | Implemented as prototype JS functions (`recomputeLoadStatusFromStops`, etc.) | Same logic, reimplemented in the domain layer (§6) with proper test coverage (§16) — the prototype's functions are a **faithful reference implementation**, not throwaway |
| **Quote creation** | Stubbed with an explanatory toast | Full Workflow 4 Quote flow (§5 `POST /quotes`, `.../convert`) |
| **Carrier Payment approval** | Stops at "Pending Approval," no separate reviewer UI | Full Draft→Pending→Approved→Paid cycle with a real Admin approval action (§5, `.../approve`) |
| **Global Search** | Opens an overlay, no live query | Real search endpoint (🔴 not yet specified — see §17) against Load/Customer/Carrier/Invoice, permission-scoped |
| **Document upload** | Simulated scan delay (`setTimeout`) | Real async scan job against `IMalwareScanner` (§8, §10) |
| **Email sending** | Toast confirmation only | Real `IEmailSender` provider call, queued as a background job (§10) |
| **PDF generation** (Rate Con, Invoice, Settlement) | Not generated — referenced as "View PDF" with a toast | Real PDF generation job (Frontend Phase 16 — PDFKit, wired as `PdfkitPdfGenerator`) |
| **Secondary CRUD** (Edit Customer, Add Contact/Location/Rate Agreement, etc.) | Confirmation toast, no persisted form | Full forms per §13.2, real endpoints per §5.1 |
| **Payment processing** | N/A — Carrier Pay/Invoicing record payments as data entry only (matches locked scope — PRD never requires actual payment *processing*, only *recording*) | Same as prototype's intent — **no gap here**, since the PRD explicitly scopes this as record-keeping, not a payment gateway integration |
| **External integrations** (GPS, accounting, load boards, EDI) | Not present | Not present — correctly out of scope for V1 in both (PRD §2, Architecture §13) |

---

## 15. Implementation Phases

Sequenced by dependency, not by the illustrative example in your prompt — each phase only begins once its prerequisites from earlier phases exist.

| Phase | Scope | Depends On |
|---|---|---|
| **0. Foundation** | Repo scaffold, CI pipeline, Postgres/Redis/S3 provisioning (dev/staging), Prisma setup, base NestJS module structure, RLS migration tooling | — |
| **1. Identity & Tenancy** | `User`, `OrganizationMembership`, `MembershipRole`, `Organization`, `OrganizationSequence`; auth endpoints; session management; RLS policies live; `AuditLog`/`DomainEvent` service (used by everything after) | Phase 0 |
| **2. Core Master Data** | Customer (+ contacts/locations/rate agreements); Carrier (+ contacts/insurance/FMCSA/service areas/factoring/drivers/trucks/trailers); Document module + malware scanning | Phase 1 |
| **3. Load Lifecycle Core** | Quote, Load, Stop; direct booking + Quote conversion; numbering | Phase 2 (needs Customer) |
| **4. Sourcing & Dispatch** | CarrierSourcingAttempt, carrier assignment + eligibility gate, Rate Confirmation generation, DispatchRecord, CheckCall, Risk Status; derived Load-status machine | Phase 3 (needs Load) + Phase 2 (needs Carrier eligibility) |
| **5. POD & Documents Completion** | Stop-level POD upload, `pod_status` derivation | Phase 4 |
| **6. Financials** | ChargeLineItem/ChargeTypeDefinition, Invoice Builder + full lifecycle, Payment, Adjustment, CarrierPayment + approval cycle, Load Closing | Phase 4–5 |
| **7. Notifications & Background Jobs** | All jobs in §10, Notification module as event subscriber | Phase 1 (events) + Phase 2 (compliance expiration needs Carrier) |
| **8. Frontend Integration** | Wire all 8 screens to the real API, replacing every prototype mock; remove the role-simulator in favor of real auth | Phases 1–7 (needs the endpoints it calls) |
| **9. Hardening** | Full permission-matrix test sweep, RLS isolation tests, security review pass | Phase 8 |
| **10. Deployment** | Environment finalization, backup/restore drill, go-live | Phase 9 |

Frontend component-library work (§13.2 shared primitives) can start in parallel with Phases 1–3, since it depends on the design system (already locked), not the API.

---

## 16. Testing Strategy

| Layer | Approach | Primary Content |
|---|---|---|
| **Unit** | Jest, no DB/network | Domain state machines (§6) — every legal transition and every illegal one asserted; derived-field functions (`deriveLoadStatus`, `derivePodStatus`, `computeEligibility`) against fixture inputs |
| **Integration** | Jest against a real test-database instance (transactional rollback per test) | Service-layer methods, including transaction correctness (e.g., numbering under simulated concurrent inserts) |
| **API** | Supertest (or equivalent) against a running app instance | Every endpoint in §5 — happy path + every documented failure case |
| **State-machine tests** | Table-driven, generated directly from §6's transition tables | One test case per row + one per illegal transition attempt |
| **Authorization tests** | Matrix-driven, generated from §7 | One test per (role × action) cell — asserts allowed actions succeed, blank-cell actions return 403 |
| **RLS/tenant-isolation tests** | Two seeded organizations, cross-org access attempts | Confirms both the application-layer filter AND RLS independently block leakage (deliberately bypass the app-layer filter in one test variant to prove RLS alone still holds, validating the defense-in-depth claim in §3.6 isn't just theoretical) |
| **Document-security tests** | Mock `IMalwareScanner` returning each status | Infected file never downloadable; quarantine prefix inaccessible; signed URL never issued pre-scan |
| **Financial calculation tests** | Fixture-based | Decimal precision (no float drift), invoice remaining-balance/status derivation, load margin/profitability against known expected values |
| **Frontend tests** | React Testing Library / Vitest | Shared primitives (Button/Badge/DataTable/Modal), `usePermissions()` hook against the same matrix fixtures as the backend authorization tests |
| **End-to-end** | Playwright | **The 10 locked workflows as the primary E2E acceptance backbone** — each workflow document's numbered steps become a scripted E2E test (e.g., `workflow-05-carrier-sourcing.spec.ts` walks Begin Sourcing → Assign (blocked on ineligible carrier) → Assign (eligible) → Generate Rate Confirmation, asserting each state transition and UI reflection along the way) |

---

## 17. Technical Decision Log — 🔒 ALL BLOCKING ITEMS RESOLVED

### 🔒 Locked (carried from earlier stages, restated for traceability)
- Modular monolith; Node.js/TypeScript backend; PostgreSQL; React frontend; S3-compatible storage; Redis-backed queue (Architecture Decision 12) — **reconfirmed this round as locked, not merely recommended.**
- Global `User` + `OrganizationMembership` identity model (Decision 1).
- REST API style (Decision 2); polymorphic Document association (Decision 3); **application authorization + PostgreSQL RLS together (Decision 4) — reconfirmed this round as locked**; mixed derived-field persistence strategy (Decision 5); `DECIMAL(12,2)` money standard (Decision 6); JSONB AuditLog convention (Decision 7); `actor_type` reserved now (Decision 8); org-scoped storage keys (Decision 9); mandatory malware scanning with quarantine and a replaceable provider (Decision 10); RPO/RTO/retention targets (Decision 11).
- Every state machine in §6; every endpoint's authorization in §7; the full DATABASE_DESIGN.md schema.

### 🔒 Resolved This Round — B1–B4
| # | Item | Resolution |
|---|---|---|
| **B1** | Check-call reminder cadence | **Locked:** simple, fixed, non-configurable V1 cadence (§10.1) — no org/user-level configuration surface in V1, architecturally extensible later via a config-source parameter change only. No new notification type or delivery channel introduced. **Exact interval (proposed: 4 hours) remains a small, explicitly-flagged, non-blocking business confirmation** — see the single remaining item below. |
| **B2** | Multi-stop charge/accessorial attribution | **Locked for V1:** no `stop_id` on `ChargeLineItem` (§4.11). Charges remain load-level; no per-stop allocation UI. Extensibility preserved for a future phase without redesigning the financial model. |
| **B3** | Custom Document/Charge type creation permission | **Locked:** Admin-only (§4.11, §7). No separate permission hierarchy introduced. Does not narrow D9 (using an existing charge type remains Admin/Ops Manager/Dispatcher/Accounting). All creation/modification is tenant-scoped and audit-logged like every other mutation. |
| **B4** | Global Search implementation | **Locked:** server-side `GET /search` endpoint (§5.4), plain indexed Postgres queries (no Elasticsearch/OpenSearch for V1), full tenant isolation + RLS, identical financial-visibility field-shaping as every other endpoint, replaceable behind a single service method for future dedicated search infrastructure. |

### ✅ Confirmed in Stage 6
- **ORM/migration tool: Prisma** (§4.1) — **accepted** per your direction (no conflict with any locked decision).
- Native PostgreSQL `ENUM` types for closed status vocabularies vs. lookup tables for extensible types (§4.4) — a direct, non-optional consequence of already-locked requirements.
- `decimal.js`/Prisma `Decimal` end-to-end for money — direct consequence of Decision 6.
- Correlation/request ID addition to AuditLog/DomainEvent (§9.3) — small additive field, doesn't alter any locked decision.
- Presigned S3 upload pattern (§8.1) — standard, low-risk implementation of already-locked object storage requirements.
- Plain Postgres `ILIKE`/`pg_trgm` search, no dedicated search engine, for V1 scale (§5.4) — direct consequence of the PRD's explicit "don't over-build for undemonstrated scale" instruction (§1.3).

### 🟡 Recommended technical implementation defaults — documented, not business rules
Per your instruction, these are ordinary technical defaults, not decisions requiring business sign-off — recorded here for transparency and easily revisited in Stage 7 without reopening any business discussion:
| # | Item | Default |
|---|---|---|
| R1 | Email provider | Frontend Phase 16 — Postmark, wired behind `IEmailSender` |
| R2 | Malware scanner provider | Frontend Phase 16 — Cloudmersive, wired behind `IMalwareScanner` |
| R3 | Login rate limiting | 10 attempts/15min per IP+email (§11) |
| R4 | Log aggregation / error tracking tool | Deferred to deployment planning (§12.2) |
| R5 | PDF generation library | Frontend Phase 16 — PDFKit, wired behind `IPdfGenerator` |
| R6 | Dependency vulnerability scanning tool | Deferred (§11) |

### 🔴 Remaining — one small, explicitly non-blocking business confirmation
| # | Item | Status |
|---|---|---|
| S1 | **Exact check-call reminder interval** (§10.1) — proposed default: **4 hours**. No locked source document specifies a number. This does not block Stage 7 — the sweep job's interval is a single named constant, trivially changed if you specify a different number before or during implementation. |

No other genuine business decisions remain open. Every other item this document surfaces (R1–R6 above) is an ordinary, low-stakes technical default that does not require business sign-off.

---

### Final Cross-Check Against All Locked Documents

Re-verified against PRD.md, all 10 workflows, ARCHITECTURE.md, architecture-decisions.md, DATABASE_DESIGN.md, and UI_UX_DESIGN.md following the B1–B4 resolutions above:
- **No locked business rule was modified.** B1–B4 and their resolutions are additive technical/scope decisions within boundaries the source documents left open, exactly as instructed.
- **No new conflict discovered** beyond the one already reported (PRD's check-call reminder promise vs. Workflow 6's silence on cadence specifics) — that conflict is now resolved by B1's fixed-cadence decision rather than left open.
- DATABASE_DESIGN.md gains no schema changes from this round (B2 explicitly declined the `stop_id` addition; B3 required no schema change, only a permission assignment on tables that already existed).
- UI_UX_DESIGN.md requires no changes — B3/B4 add backend endpoints for interactions (custom type management, global search) that were already described at the UX layer without needing a new screen design.

**Stage 6 (Technical Architecture) is complete.** No application code, migrations, or deployment configuration have been written.
