# Stage 3: System Architecture
**Status:** Draft — pending confirmation of Open Decisions (Section 25)
**Source of truth:** [docs/PRD.md](PRD.md), [docs/workflows/](workflows/) (all 10 locked Stage 2 workflows)
**Explicitly out of scope here:** database schema (tables/columns/indexes/FKs/migrations) — that is Stage 4.

## How to read this document
Every section is split into up to three parts:
- **Locked (from PRD/Workflows):** facts already decided in Stage 1/2 that constrain the architecture. Never reinterpreted here.
- **Architecture Recommendation:** this stage's proposal — reasoned, but not yet a business decision.
- **Open Decision:** something Stage 1/2 didn't resolve and that Stage 4 (Database Design) cannot proceed without an answer to. Collected in full in Section 25.

---

## 1. System / Application Architecture

**Architecture Recommendation**
A **modular monolith**, not microservices, for V1. At 100–500 loads/day across an initially small number of organizations (PRD §1.3), the operational overhead of microservices (service discovery, distributed transactions, network failure handling) outweighs any benefit. A monolith also makes the many multi-step, transactional workflows locked in Stage 2 (e.g., Quote→Load conversion writing to two entities atomically, Carrier Payment approval writing to payment + audit + settlement doc in one operation) far simpler to implement correctly.

Internally, the application is layered:
```
API / Controller layer      (HTTP handling, request validation, auth context)
        ↓
Application / Service layer (workflow orchestration — this is where Workflows 1–10 live, one service method per workflow step)
        ↓
Domain layer                (entities, state machines, business rules, invariants)
        ↓
Data Access layer           (repositories — the only layer that talks to the database)
```
No layer is skipped: controllers never touch the database directly, and no module's data access layer is called from outside that module's own service layer (see §6).

**Rationale:** this preserves a clean extraction path later — if a specific module (most likely Tracking, if GPS/ELD ingestion volume grows) needs to become an independently-scaled service, its service-layer boundary is already the seam to cut along.

---

## 2. Multi-Tenant Organization Architecture & Tenant Isolation

**Locked (from PRD/Workflows)**
- Every business entity belongs to exactly one `Organization`; users only ever see their own organization's data (PRD §1.1, §7).
- A **Platform Super Admin** role exists above all organizations, provisions them, but does **not** automatically receive access to an organization's operational/financial data (Workflow 1, §1.1).
- `Organization.default_payment_terms` is set at provisioning (Workflow 1) — confirms Organization itself carries org-level configuration, not just being a grouping label.

**Architecture Recommendation**
- **Shared database, shared schema, row-level isolation**: every tenant-scoped table carries `organization_id`. This matches the PRD §12 preliminary recommendation and remains appropriate at target scale.
- A **request-scoped tenant context** is established once at authentication (from the authenticated user's `organization_id`) and threaded through every service call. No service method accepts a caller-supplied `organization_id` as a trusted parameter — it is always derived from the authenticated session, never from client input, to prevent cross-tenant data access via a tampered request.
- **Defense-in-depth**: in addition to application-layer scoping, use database-level Row-Level Security (Postgres RLS, if Postgres is selected — see §21) as a second, independent enforcement layer, so a bug in one service's query-scoping logic cannot leak cross-tenant data.
- **Platform Super Admin access model**: the Super Admin's own actions (provisioning, platform configuration) run in a separate "platform" context with no `organization_id` scope at all. Support-style access into a specific organization's data (not built in V1, but the PRD implies it may be needed eventually) should require an explicit, time-boxed, audited elevation — never an implicit bypass of the tenant boundary.

---

## 3. Authentication & Authorization Architecture

**Locked (from PRD/Workflows)**
- Email + password authentication; email verification required for the initial Admin (Workflow 1, §1.3); invitation-based activation for subsequent users (Workflow 1, §1.5); password policy detail explicitly deferred to technical architecture.
- Users can hold **multiple roles** simultaneously (Workflow 1, §7).
- No user deletion — only deactivation (Workflow 1, §1.8); deactivated users' sessions are terminated immediately (Workflow 1, §1.7).

**Architecture Recommendation**
- Passwords hashed with a modern adaptive algorithm (bcrypt or argon2); verification/invitation tokens are single-use, time-limited, and stored hashed (not plaintext) — standard practice, not yet a locked business decision but not really a debatable one either.
- Session model: server-side session or short-lived JWT + refresh token — either is workable; recommend **server-side session** for simplicity of the immediate-revocation requirement in Workflow 1 §1.7 (a stateless JWT makes "terminate sessions immediately" harder without an additional revocation-list mechanism).
- SSO/OAuth is not mentioned anywhere in the PRD — treated as fully out of scope, not even architecture-reserved, unless you tell me otherwise.

**Open Decision**
**Global vs. org-scoped user identity.** Workflow 1 contains an unresolved tension: initial Organization creation validates the primary contact email as "a valid, uniquely-usable email... a user's login identity is global even though data is org-scoped" (§1.1), but the invitation step (§1.4) only checks for duplicates **within that organization**, implying the same email address could plausibly exist as an independent user in a different organization. This has real architectural consequences:
- **Model A — Global identity, multiple org memberships** (like Slack/GitHub-org style): one `Person`/login record, with one or more `OrganizationMembership` rows (each carrying roles). One password, one login, org-switching inside the app.
- **Model B — Fully org-scoped users**: the same email can independently register as an unrelated `User` row in two different organizations, each with its own password and identity, no linkage between them.

This must be resolved before Stage 4, since it changes the shape of the `User` table fundamentally (single table with a join table to Organization, vs. `User` simply carrying `organization_id` directly as in the workflow drafts). **My recommendation is Model B (fully org-scoped users)** for V1 — it matches how every workflow so far was actually drafted (`User.organization_id` directly), is simpler to build, and avoids designing a multi-org-membership UX (org switcher, etc.) that was never discussed. Model A can be introduced later without breaking Model B's data if needed. Flagging for your confirmation.

---

## 4. RBAC & Permission Enforcement

**Locked (from PRD/Workflows)**
- Core roles: Admin, Operations Manager, Dispatcher, Sales/Booking, Accounting (PRD §3); Platform Super Admin is separate and not org-scoped (Workflow 1).
- Financial data (revenue, cost, margin, invoices, payments, AR/AP) is hidden from Dispatchers by default (PRD §7, §9).
- A distinct **Compliance-approval permission** exists, separate from Carrier-creation permission (Workflow 3, §2) — proof that V1 already needs more than a flat role-to-module mapping.
- **Segregation-of-duties rules** recur twice: uploader ≠ approver for carrier compliance documents (Workflow 3, §3.4), and preparer ≠ approver for carrier payments, with Admin-only approval authority (Workflow 9, §9.4).
- Zero-Admin protection: an organization can never be left with zero active Admins (Workflow 1, §1.7).

**Architecture Recommendation**
- Implement RBAC as **roles → permissions**, not hardcoded `if (user.role === 'Admin')` checks scattered through the codebase. A central **authorization/policy module** exposes permission checks (e.g., `can(user, action, resource)`), called at the start of every service-layer method — this is the single enforcement point referenced throughout the workflows (e.g., "creating user's role is one of...").
- Model the Compliance-approval permission as its own permission flag, assignable independent of a user's role set (or as a role a user can additionally hold, e.g., "Compliance Reviewer" as a 6th assignable role) — either works; recommend treating it as an additional assignable role for consistency with the existing multi-role model, rather than inventing a separate permission-flag mechanism just for this one case.
- **Segregation-of-duties** (uploader≠approver, preparer≠approver) is a business rule, not a permission check — implement as an explicit guard in the relevant service method ("is the acting user the same as the record's `created_by`/`prepared_by`?"), reusable as a small shared utility since the same pattern recurs and will likely recur again.
- **Financial visibility** is enforced at the API/serialization boundary: define permission-aware response shapes (e.g., a "public" Load view vs. a "financial" Load view) rather than trusting the frontend to hide fields it received. A Dispatcher's API response for a Load literally does not contain `customer_rate`/`carrier_rate`/`margin` fields, not just a UI that hides them.

---

## 5. Frontend / Backend / API Boundaries

**Architecture Recommendation**
- Single-page application (SPA) frontend, communicating with the backend exclusively through a versioned internal API. The backend is the sole enforcement point for every business rule defined in Workflows 1–10 — the frontend never independently enforces a status-transition rule, eligibility check, or permission; it only reflects what the API allows and returns.
- API style: **REST**, resource-oriented (`/loads`, `/customers`, `/carriers`, `/quotes`, `/invoices`, etc.), versioned from day one (`/api/v1/...`) even though it is not public yet — this directly serves the PRD's future Public API requirement (§10) without rework, since the future public API is meant to expose the same resources through the same service layer.
- Treat today's internal API **as if it will become the public API later** in terms of discipline (consistent error shapes, pagination, resource naming) — cheap to do now, expensive to retrofit.

**Open Decision**
REST vs. GraphQL is a legitimate alternative given the Dispatch Board's need for flexible, nested, filterable data (Loads with Stops, Carrier, Documents, etc. in varying combinations per view). I'm recommending REST for V1 for tooling simplicity and because the public-API future requirement (PRD §10) is more conventionally REST in the freight/logistics integration space (carriers/customers' own systems will expect REST or EDI, not GraphQL). Confirm or override.

---

## 6. Core Service / Module Boundaries

**Architecture Recommendation** — one module per bounded context, matching the entity groupings already established in PRD §4 and used consistently across Workflows 1–10:

| Module | Owns | Key Workflows |
|---|---|---|
| **Identity & Access** | User, Role assignment, sessions, invitations | 1 |
| **Organization** | Organization record, org-level settings (default payment terms, etc.) | 1 |
| **Customer** | Customer, Customer Contact, Customer Location, Customer Rate Agreement | 2 |
| **Carrier** | Carrier, Carrier Contact, Compliance Documents, Insurance, FMCSA Verification, Factoring Info, Driver, Truck, Trailer, Assignment Eligibility | 3 |
| **Quote/Load** | Quote, Load, Stop, Reference Numbers, Charge Line Items, status state machines | 4, 6 |
| **Sourcing** | Carrier Sourcing Attempt | 5 |
| **Dispatch/Tracking** | Dispatch Record, Check Call, Risk Status | 6 |
| **Document** | Document (polymorphic), versions, Document Center | 3, 5, 7 |
| **Billing (Customer)** | Invoice, Invoice Line Item, Payment, Adjustment | 8 |
| **Carrier Pay** | Carrier Payment, Settlement Document | 9 |
| **Audit** | Audit Log (write API used by every other module) | all |
| **Notification** | Notification records, delivery (in-app only in V1) | 3 (expiration alerts) |
| **Reporting** | Read-only cross-module queries, dashboards, exports | — |

**Rule:** every module owns its own tables exclusively. Cross-module interaction happens **only** through another module's service-layer API — e.g., when Workflow 5 needs to check `Carrier.assignment_eligible`, the Quote/Load and Sourcing modules call the Carrier module's service method, never query the Carrier tables directly. The one deliberate exception is **Reporting**, which is explicitly permitted to read across modules directly (per PRD §9: "reports generated from live transactional data... not duplicated reporting tables") since it has no write responsibility and enforcing full service-layer indirection for every dashboard query would be needless overhead.

---

## 7. Load Lifecycle / State-Management Architecture

**Locked (from PRD/Workflows)** — every state machine below is fully specified in Stage 2, not open to reinterpretation:
- **Quote:** `OPEN → WON | LOST` (both terminal; `LOST` is permanently terminal, cannot reopen) — Workflow 4.
- **Load:** `BOOKED → CARRIER_SOURCING → CARRIER_ASSIGNED → RATE_CONFIRMATION → DISPATCHED → PICKUP → IN_TRANSIT → DELIVERED → [CLOSED]`, with a `CARRIER_ASSIGNED → CARRIER_SOURCING` rejection loop (Workflow 5) — Workflows 4–6, 10.
- **Stop:** `PENDING → ARRIVED → COMPLETED` — Workflow 6.
- **Compliance Document:** `Uploaded → Pending Review → Approved | Rejected`, with time-based `→ Expired` — Workflow 3.
- **Carrier Payment:** `DRAFT → PENDING_APPROVAL → APPROVED → PAID`, with a `PENDING_APPROVAL → DRAFT` rejection loop — Workflow 9.
- **Invoice:** `DRAFT → SENT → PARTIALLY_PAID → PAID`, with `OVERDUE` computed (not a stored transition) and `VOID`/`CREDITED` side-states — Workflow 8.

**Architecture Recommendation**
- Implement each of the above as an explicit **state machine in the domain layer** — a transition method that (a) validates the current state permits the requested transition, (b) validates any preconditions specific to that transition (e.g., Load `RATE_CONFIRMATION → DISPATCHED` requires the full gate from Workflow 6 §6.1), (c) performs the mutation, (d) emits an audit event (§9) — every time, with no code path that mutates a status field without going through this method.
- **Derived vs. directly-set status**, per Workflow 6's explicit rule ("Load status cannot be manually set ahead of what stop progress supports"): Load status transitions from `DISPATCHED` onward are **derived**, triggered by Stop-level events, not directly settable by a user action — recalculated the same way every time (§11).

---

## 8. Document Storage & Document Association Architecture

**Locked (from PRD/Workflows)**
- Documents attach to Load, Stop, Customer, Carrier, Driver, Truck, Trailer, Invoice, Carrier Payment (PRD §4; Workflow 7 specifically requires Stop-level association).
- Versioning: new uploads create new versions, old versions retained, one current version (PRD §9).
- File types: PDF, JPG, JPEG, PNG in V1 (PRD §10.2 in the original Documents section).
- No separate document system per entity — one reusable document architecture (PRD §9, explicit requirement).

**Architecture Recommendation**
- **Polymorphic association**: a `Document` table with `entity_type` + `entity_id` columns (rather than a nullable foreign key per possible parent entity) — this is the pattern that naturally satisfies "reusable across entity types," and is confirmed here as the direction; exact implementation (native polymorphic columns vs. a join table) is a Stage 4 schema decision, not resolved here.
- **File storage**: object storage (S3-compatible), never inside the application database. The `Document` table stores metadata + storage key only. Storage keys should be unpredictable (UUID-based), never derived from user-supplied filenames.
- **Access control**: files are served only via short-lived signed URLs generated **after** an authorization check in the service layer — never a publicly-readable bucket/prefix. This is what makes the permission rules from Workflow 3 (compliance docs) and the PRD's document-visibility rule ("both the user's permissions and access to the parent entity") actually enforceable at the file level, not just the metadata level.

---

## 9. Audit Logging Architecture

**Locked (from PRD/Workflows)** — every workflow specifies exact audit events (organization, actor, timestamp, action, entity, previous value, new value, reason where applicable). This is one of the most consistently detailed requirements across all 10 workflows.

**Architecture Recommendation**
- **One universal `AuditLog`**, not per-entity history tables. Every module writes to it through a single shared **Audit service method**, never by direct insert — this guarantees consistent shape across the ~60 distinct audit event types already named across Workflows 1–10 (`User Deactivated`, `Carrier Assigned`, `Invoice Sent`, etc.).
- Store `previous_value`/`new_value` as structured (JSON) data rather than typed columns, since the audit log spans wildly different entity types (a user role change vs. a rate change vs. a document approval) — a fixed relational schema for "previous/new value" would force awkward generalization.
- **Architectural link to future needs**: model each audit-worthy action internally as a small **domain event** (e.g., `LoadDispatchedEvent`, `InvoicePaidEvent`) that the Audit module subscribes to. This is not extra work for V1 (the Audit module is still the only real subscriber), but it means the Notification module (§12) and, later, webhooks (§13) can subscribe to the exact same event stream without the emitting module ever needing to change. This directly serves PRD §10's principle that "external integrations should not directly manipulate database records."

---

## 10. Financial Calculation Architecture

**Locked (from PRD/Workflows)**
- Original rates are never overwritten; changes are new line items/adjustments (PRD §8; Workflow 4 §4.4 for rate-agreement overrides; Workflow 8 §8.11 for invoice adjustments).
- Gross Profit = Revenue − Carrier Cost; Margin % = Gross Profit / Revenue (PRD §8).
- Invoice remaining balance, status, and Overdue are all **derived** (Workflow 8 §8.9/§8.10); Carrier Payment remaining balance likewise (Workflow 9 §9.7).

**Architecture Recommendation**
- All monetary values use a **fixed-point/decimal type** end-to-end (database column, application-layer type, API serialization) — never floating point, anywhere. This is non-negotiable for a financial system and should be locked as a hard constraint carried into Stage 4 and Stage 6.
- Split derived-value strategy by read pattern (see also §11):
  - **Invoice `OVERDUE`**: computed at read-time (explicitly locked, Workflow 8 §8.10 — "no scheduled recalculation job required").
  - **Invoice `remaining_balance`, Carrier Payment `remaining_carrier_balance`**: recalculate and persist transactionally on every payment/adjustment write (read frequently — dashboards, AR/AP aging — cheaper to keep current than to sum on every read).
  - **Load-level Gross Profit/Margin**: compute at read-time from the load's own line items (a single load's line items are a small, cheap set to sum); reporting rollups (by customer/carrier/lane/date) aggregate across many loads and should use the database's own aggregation (SQL `SUM`/`GROUP BY`) rather than pulling raw rows into the application layer, consistent with PRD §9's "generate reports from live transactional data" principle.

---

## 11. Derived Milestones (e.g., `pod_status`)

**Locked (from PRD/Workflows)**
- `Load.pod_status` (`NOT_RECEIVED` / `PARTIAL` / `COMPLETE`) is derived from delivery-Stop-level POD documents, never directly settable (Workflow 7 §7.2).
- `Carrier.assignment_eligible` is derived from a 7-condition rule set, recalculated on every relevant compliance change (Workflow 3 §3.8).
- `Load.status` from `DISPATCHED` onward is derived from Stop progress (Workflow 6 §6.6).

**Architecture Recommendation**
These three are the same architectural pattern used three times — worth implementing **once**, as a shared internal convention, rather than three bespoke implementations:
1. A triggering event occurs (document uploaded/approved/expired, stop arrival/departure recorded, insurance record changed).
2. A recalculation function re-derives the field purely from current source-of-truth child records (never from a cached "delta").
3. If the recalculated value differs from the stored value, persist it and write an audit event (`Assignment Eligibility Changed`, `POD Milestone Updated`, `Load Status Advanced`).

Recommend **persisting** (not computing at read-time) all three, since each is read on high-traffic surfaces (Dispatch Board, carrier-assignment screens, closing checklist) where recomputing from child records on every read would be wasteful at scale — this is the opposite tradeoff from Invoice `OVERDUE` (§10), which is cheap to compute (a date comparison) and read comparatively rarely.

---

## 12. Notifications / Event Architecture (Deferred Delivery, Ready Architecture)

**Locked (from PRD/Workflows)**
- In-app notifications only in V1; email notifications explicitly deferred (PRD §12, Workflow 3 §3.10 confirms in-app delivery for the one concrete V1 notification type — compliance expiration warnings at 30/15/7 days).
- Notification architecture "should be designed so additional channels can be added later" (PRD §12).

**Architecture Recommendation**
- Build a generic `Notification` module now: `recipient_user_id`, `type`, `related_entity`, `read/unread`, `created_at`, delivered via a single in-app channel in V1.
- Drive it off the **same domain-event stream** introduced in §9 — the Notification module subscribes to events (`ComplianceItemExpiringEvent`, etc.) exactly like the Audit module does. This means adding email delivery later is "add a new subscriber to an existing event," not "build an event system that doesn't exist yet."
- Scheduled sweeps (§16) are what actually **produce** these events for time-based cases (expiration warnings); user actions produce them directly (e.g., a carrier rejection could someday page a manager) — V1 only needs the compliance-expiration case, per Workflow 3.

---

## 13. Integration Architecture & Future Readiness

**Locked (from PRD/Workflows)**
- No integrations built in V1. Explicit architectural principle: "external integrations should not directly manipulate database records without going through application/business logic" (PRD §10.3).
- Priority order for future integrations: Accounting (1) → GPS/ELD (2) → Load Boards (3) → EDI/Public API/Webhooks (later).

**Architecture Recommendation**
- Every future integration — inbound (GPS location updates, EDI load tenders) or outbound (webhooks, accounting sync) — is architected to go through the **same service layer** as the web frontend (§1, §6). A GPS integration, when built, calls the Tracking module's existing "record check call / update location" service method; it does not get a shortcut path into the `CheckCall` table.
- The domain-event stream (§9, §12) is the natural foundation for future **webhooks**: a webhook dispatcher is just another event subscriber that POSTs to a configured external URL instead of writing a notification row.
- Recommend an **outbox pattern** (events written transactionally alongside the state change, delivered asynchronously by a separate worker) once webhooks or external sync are actually built — not needed for V1's in-process event subscribers (Audit, Notification), but worth naming now since it's the natural next step and shapes how the event table should already look.

---

## 14. Future Portal Architecture (Customer & Carrier)

**Locked (from PRD/Workflows)**
- Reserved relationships: `Organization → Customer → Customer Users`, `Organization → Carrier → Carrier Users` (PRD §2, §4). Not built in V1.

**Architecture Recommendation**
- Reserve, don't build: model future portal users as a **distinct identity space** from internal Users — e.g., a future `ExternalUser` concept linked to exactly one `Customer` or `Carrier` (never both), with its own permission model (view-only scoped to "their own" loads/documents/invoices) that never shares the internal 5-role RBAC enum (§4). Mixing internal and external identity into one `User` table with a "type" flag would risk internal-role logic accidentally applying to an external actor — worth avoiding architecturally even though nothing is built yet.
- The portal's future API surface, when built, is the same internal service layer as everything else (§1) — a Customer Portal is just a different frontend + a heavily permission-scoped API consumer, not a parallel backend.

---

## 15. AI-Readiness Without Implementing AI

**Locked (from PRD/Workflows)**
- AI is fully out of V1. Standing principle: AI may suggest/draft/recommend but never take a binding action unilaterally; every AI action must go through the same auth/business-rules/audit as a human user (PRD §11).

**Architecture Recommendation**
- Because §1, §4, and §9 already establish that **every** action — human or otherwise — must pass through the service layer's permission checks and audit logging, a future AI agent requires no special architecture: it is simply another authenticated actor (most likely a dedicated "AI service account" with its own scoped permissions) calling the same APIs.
- One small forward-looking addition worth making now rather than later: give `AuditLog.actor_type` an enum (`human`, `system`, `ai`) even though only `human` and `system` are used in V1 — this avoids a migration later purely to distinguish AI-driven audit entries from user-driven ones, which the PRD explicitly requires recording (capability, input/context, recommendation, human decision, final action).

---

## 16. Background Jobs / Scheduled Processes

**Locked (from PRD/Workflows)** — concrete V1 jobs already implied by locked workflow decisions:
| Job | Cadence | Source |
|---|---|---|
| Invitation expiration sweep | Time-based (7-day check) | Workflow 1 §1.6 |
| Quote expiration sweep | Daily (or more frequent) | Workflow 4 §4.5 |
| Carrier compliance/insurance expiration sweep | Daily | Workflow 3 §3.9 |
| Expiration notification thresholds (30/15/7 days) | Daily | Workflow 3 §3.10 |
| Transactional email sending (Rate Con, Invoice) | Async, on-demand | PRD §10.1 |
| Document/PDF generation (Rate Con, Invoice, Settlement) | Async, on-demand | Workflows 5, 8, 9 |

**Architecture Recommendation**
- A **durable background job queue**, separate from the request/response cycle, for anything not required to complete before the HTTP response returns (PDF generation, email sending) — keeps user-facing actions fast and makes these operations retryable on transient failure.
- A **scheduler** (cron-style) triggers the daily sweeps above; each sweep is itself just another call into the relevant module's service layer (e.g., the compliance-expiration sweep calls the Carrier module's existing eligibility-recalculation method — it does not duplicate that logic).
- Explicitly **not** needed per locked decisions: a scheduled job for Invoice `OVERDUE` (Workflow 8 §8.10 explicitly says computed-at-read is sufficient) — worth calling out so this isn't accidentally over-built at Stage 6.

---

## 17. File Storage & Security

**Architecture Recommendation** (extends §8)
- Object storage with **org-scoped key prefixes** (e.g., `org_{id}/...`) as isolation-in-depth — even though access is enforced at the application layer, a physically partitioned storage layout limits the blast radius of a misconfigured bucket policy or a bug.
- Time-limited **signed URLs** for all file access, generated only after the requesting user's permission has been checked in the service layer.
- Upload-time validation: file type restricted to the locked V1 set (PDF/JPG/JPEG/PNG), file size capped at a reasonable limit (exact number deferred to Stage 6, per PRD §10.2's "reasonable file-size limit... finalized during technical architecture").

**Open Decision**
Malware/virus scanning on upload was never discussed in the PRD. Given carriers and customers (and, eventually, portal users) will be uploading files, recommend adding basic scanning before Stage 6 finalizes storage architecture — flagging as an open item rather than assuming it in.

---

## 18. Data Security, Tenant Isolation, Encryption, Backups & Retention

**Locked (from PRD/Workflows)**
- Financial integrity principle: nothing is silently overwritten; adjustments/credit memos/additional line items are the only way to change a financial outcome (PRD §8). This implies audit and financial records are **never purged** in V1 — no retention/deletion policy was ever discussed, which itself is informative: treat retention as indefinite by default.

**Architecture Recommendation**
- Encryption in transit (TLS) everywhere; encryption at rest for both the database and object storage — standard baseline, not really a debatable tradeoff for a system holding carrier banking/factoring details and customer financial data.
- Tenant isolation enforcement as described in §2 (application-layer + RLS defense-in-depth).
- Automated, regular database backups — exact RPO/RTO targets are a business decision, not an engineering one, and were never discussed.

**Open Decision**
Backup frequency/retention and disaster-recovery targets (RPO/RTO) need explicit business input before Stage 6 — e.g., "how much data loss is acceptable in a worst case" and "how long can the system be down." Not something this document should assume.

---

## 19. Observability, Logging, Error Handling & Monitoring

**Architecture Recommendation**
- Distinguish clearly from the business **AuditLog** (§9): this is **operational/technical logging** — structured application logs, request/response logging, error stack traces, performance timing — used for debugging and system health, not for business history.
- Centralized log aggregation and error tracking (e.g., a Sentry-style error monitoring service) so failures in async jobs (§16) — which by design don't surface to a user waiting on a screen — are still visible to the team.
- Health-check endpoints and job-queue monitoring are particularly important here specifically because several **locked business behaviors depend on scheduled jobs actually running** (compliance expiration eligibility, quote expiration, invitation expiration) — a silently-failing scheduler would violate those workflows without anyone noticing until a carrier gets assigned who shouldn't have been eligible.

---

## 20. Scalability Considerations

**Architecture Recommendation**
- At the PRD's target scale (100–500 loads/day, hundreds–thousands of carriers, multiple orgs), shared-DB multi-tenancy and a modular monolith are appropriate — no premature optimization needed, consistent with PRD §1.3's explicit instruction.
- The **web/application tier** should be stateless (session state in the database or a shared cache, not in-process) so it can scale horizontally behind a load balancer without added complexity.
- The **database** is the most likely long-term bottleneck given the audit-heavy, financially-precise, multi-tenant write pattern — recommend a managed relational database with a clear path to read replicas (useful for Reporting's direct cross-module reads, §6) as the first scaling lever, well before considering any tenant-database-splitting strategy.
- The **background job queue** (§16) should be able to scale worker count independently of the web tier, since PDF generation and email sending have very different load characteristics than HTTP request handling.

---

## 21. Recommended Technology Stack (Preliminary — Finalized in Stage 6)

This is a genuine recommendation, not an exhaustive options survey — Stage 6 (Technical Architecture) is where this gets finalized, revisited, and detailed (exact library versions, hosting provider specifics, CI/CD tooling).

| Layer | Recommendation | Why |
|---|---|---|
| Backend language/framework | **Node.js + TypeScript**, a modular/opinionated framework (e.g., NestJS) | TypeScript's module/dependency-injection patterns map cleanly onto the module-boundary architecture in §6; shared language with the frontend reduces context-switching for a small team |
| Database | **PostgreSQL** | Strong transactional/relational guarantees (critical for the financial and state-machine integrity locked in Stage 2), native Row-Level Security for tenant-isolation defense-in-depth (§2), JSONB support fits the Audit Log's structured previous/new values (§9), mature `DECIMAL` type for money (§10) |
| Frontend | **React + TypeScript** SPA | Matches the Dispatch Board's need for a highly interactive, stateful UI (table/kanban/calendar views, per PRD §6); large ecosystem for the data-grid-heavy screens this domain requires |
| Object storage | **S3-compatible** object storage | Matches §8/§17 requirements directly; broadly portable across cloud providers |
| Background jobs | **Redis-backed queue** (e.g., BullMQ) + cron-style scheduler | Matches §16's durable async job requirements |
| Auth | In-app session-based auth (no third-party auth vendor assumed) | Matches §3's requirement for immediate session revocation on deactivation |

**Open Decision:** whether to use a managed/hosted version of each of the above (e.g., managed Postgres, managed Redis) versus self-hosting is a Stage 6/22 decision tied to budget and operational capacity — not resolved here.

---

## 22. Deployment / Environment Architecture (Preliminary — Finalized in Stage 6)

**Architecture Recommendation**
- Standard three-environment model: development, staging, production.
- Containerized application deployment (Docker) for portability and consistency across environments.
- Managed cloud database rather than self-hosted, given the financial/compliance sensitivity of the data (§18) and the operational burden self-hosting would add.
- CI/CD pipeline that runs database migrations as a controlled, reviewed step before deploying application code that depends on them — relevant here because Stage 4's schema will need a migration discipline from day one.
- Rolling or blue/green deployment strategy, since this is an operational system dispatchers and accounting rely on during business hours — avoid deployment-caused downtime windows.

*Full detail (specific hosting provider, infrastructure-as-code tooling, exact CI/CD platform) is deferred to Stage 6, consistent with the PRD's original Section 12 guidance.*

---

## 23. Architecture Tradeoffs & Rationale (Summary)

| Decision | Chosen | Alternative Considered | Why |
|---|---|---|---|
| Monolith vs. microservices | Modular monolith | Microservices per domain | Target scale doesn't demand it; monolith makes the many multi-entity transactional workflows (Quote→Load, Carrier Payment approval) far simpler; module boundaries preserve a future extraction path |
| Shared-DB vs. isolated-DB multi-tenancy | Shared DB, row-level isolation | Database-per-tenant | Lower operational cost/complexity at current scale; revisit only if a specific enterprise/compliance-sensitive customer requires physical isolation later |
| Derived-field strategy | Mixed: persisted+recalculated for high-read fields (`pod_status`, `assignment_eligible`, Load status), computed-at-read for low-read/cheap fields (Invoice `OVERDUE`) | One uniform strategy | Matches each field's actual read frequency and computation cost, per the specific rules already locked in Workflows 3, 6, 7, 8 |
| Building the event/audit backbone now | Yes, even though Notifications/Webhooks/AI are deferred | Build audit logging only, add an event system later when webhooks are actually built | Small added cost now (one shared event-emission pattern) avoids a larger rework later, and directly serves the PRD's explicit "architecture-ready" requirement across §10 (Integrations), §11 (AI), and §12 (Notifications) |
| REST vs. GraphQL | REST | GraphQL | Simpler tooling, better fit for a future public API serving carriers/customers who expect conventional REST/EDI-style integration; flagged as an open decision above since the Dispatch Board's nested-data needs are a legitimate GraphQL argument |

---

## 24. Summary: What Stage 4 Can Now Build On

Stage 4 (Database Design) can proceed with confidence on:
- The module boundaries in §6 (which tables belong to which module/service).
- Every state machine in §7 (exact legal transitions, already fully specified in Stage 2).
- The polymorphic Document pattern in §8.
- The single universal AuditLog pattern in §9.
- The decimal/money-type requirement and derived-field persistence strategy in §10/§11.
- The `organization_id`-scoped, row-level multi-tenancy model in §2.

Stage 4 **cannot** finalize schema-level specifics until the Open Decisions in §25 are answered — most importantly the User identity model (§3), since it directly determines the `User` table's shape and every foreign key that references it.

---

## 25. Stage 3 Architecture Decision Log

Decisions that must be explicitly confirmed (or overridden) before Stage 4 begins:

| # | Decision | My Recommendation | Why It Blocks Stage 4 |
|---|---|---|---|
| 1 | **User identity model** — org-scoped users (Model B) vs. global identity with multi-org membership (Model A) | Model B (org-scoped) | Determines the `User` table's shape and every FK referencing it |
| 2 | **API style** — REST vs. GraphQL | REST | Doesn't block table design directly, but affects how derived/nested data (e.g., Load+Stops+Documents) is shaped for retrieval, which can influence schema convenience decisions |
| 3 | **Polymorphic Document association** — generic `entity_type`/`entity_id` columns vs. explicit per-entity join tables | Generic polymorphic columns | Direct schema-shape decision for the `Document` table |
| 4 | **Row-Level Security** — enforce tenant isolation at the DB layer (Postgres RLS) in addition to the application layer, or application-layer only | Use RLS as defense-in-depth | Affects whether Stage 4 needs to design RLS policies alongside the schema |
| 5 | **Derived-field persistence strategy per field** — confirm the specific list (persist: `pod_status`, `assignment_eligible`, `Load.status`; compute-at-read: Invoice `OVERDUE`) | As specified in §11/§10 | Determines whether Stage 4 needs extra columns + recalculation triggers, or can rely on query-time computation |
| 6 | **Money/decimal type standard** — exact precision/scale for all monetary columns | e.g., `DECIMAL(12,2)` (or higher precision if fractional-cent accessorial math is ever needed) | Must be consistent across every financial table in Stage 4 |
| 7 | **Audit log value serialization** — structured JSON for previous/new values vs. plain text | Structured JSON | Determines the `AuditLog` table's column design |
| 8 | **Actor model for AI/system audit entries** — add `actor_type` enum now vs. later | Add now (`human` / `system` / `ai`) | Cheap now, a migration later if deferred |
| 9 | **File storage isolation** — org-scoped key prefixes in object storage | Yes | Not a DB schema issue directly, but affects the `Document.storage_key` convention Stage 4 will store |
| 10 | **Malware/virus scanning on upload** | Recommend adding | Not previously discussed anywhere in PRD/Workflows |
| 11 | **Backup/retention & RPO/RTO targets** | Needs explicit business input | Not an engineering decision; affects infra planning in Stage 6, flagged here since it was never addressed |
| 12 | **Technology stack** (Node/TypeScript + NestJS, PostgreSQL, React, S3-compatible storage, Redis-backed queue) | As specified in §21 | PostgreSQL specifically affects Stage 4's available features (RLS, JSONB, DECIMAL) |

---

*Stage 3 complete pending confirmation of the items in Section 25. No database tables, columns, indexes, foreign keys, or migrations have been designed — that is Stage 4, and should begin only after the Open Decisions above are resolved.*
