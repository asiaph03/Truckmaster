# Stage 3 — Open Architecture Decision Resolution
**Status:** 🔒 ALL 12 DECISIONS LOCKED — Stage 4 (Database Design) authorized to proceed
**Source:** Resolves the 12 open items logged in [docs/ARCHITECTURE.md](ARCHITECTURE.md) §25
**Scope:** Architecture-level decisions only. No database tables, columns, indexes, or migrations are designed here — that remains Stage 4.

**Legend**
- 🔒 **LOCKED** — explicitly directed by you; treated as final for Stage 4.
- 🟡 **RECOMMENDED** — my proposal stands from ARCHITECTURE.md; needs your confirmation, not a business judgment call I should make alone.
- 🔴 **STILL NEEDS USER DECISION** — a genuine business tradeoff (cost, risk tolerance, vendor choice) with no correct engineering answer; I am not assuming a default.

---

## Decision 1 — User Identity Model 🔒 LOCKED

**Current architecture recommendation (superseded):** ARCHITECTURE.md originally recommended org-scoped users (Model B) as the lower-effort V1 default, flagging global identity as an alternative.

**Your direction:** Use **global identity with organization membership**:
```
User → OrganizationMembership → Organization
```
A person has exactly one global account. That account can hold membership in one or more Organizations. Roles and permissions are assigned **per membership**, not on the global User record.

### Options considered
| Option | Description |
|---|---|
| A — Global User + OrganizationMembership *(chosen)* | One identity, one password, N memberships, each with its own roles |
| B — Org-scoped User | Same email can exist as unrelated, independently-authenticated accounts in different orgs |

### Pros / Cons

| | Model A (Global + Membership) | Model B (Org-scoped) |
|---|---|---|
| Pros | Matches real-world cases (a person consulting across two brokerages, a factoring contact who touches multiple orgs, future M&A/consolidation); one password to manage; Platform Super Admin model falls out naturally (see below); cleaner audit trail per person; no data duplication if the same person needs a second org later | Simpler to build initially; no org-switcher UI needed; matches how Workflow 1 was literally drafted |
| Cons | Requires an org-switcher UI/session concept; slightly more schema complexity (extra join table); invitation flow has two sub-cases (new identity vs. existing identity) | A real person needing access to two orgs ends up with two disconnected accounts/passwords; harder to retrofit into Model A later without a migration touching every FK that currently points at "User" |

### Implications

**Authentication**
Login authenticates against the global `User` (email + password) — one identity, one credential set, regardless of how many organizations that person belongs to. After authentication, the system determines the user's active `OrganizationMembership` records. If exactly one active membership exists (the common V1 case, since org creation is invite-only), the session enters that organization's context automatically. If more than one exists, the user selects an organization (or the system defaults to their most-recently-used one) before entering the app.

**Organization switching**
A session carries both `user_id` and a **current organization context** (the active `OrganizationMembership`). All in-app data, permission checks, and UI are scoped to that current context — switching organizations is a first-class, always-available action for any user with more than one active membership, not a special/rare case requiring re-login. For most V1 users (single-org) this is invisible; the architecture simply doesn't block the multi-org case when it does occur.

**Tenant isolation**
Isolation is, if anything, **more explicit** under this model. Rather than isolation being implicit ("the user only ever had one org_id"), every request's claimed `organization_id` must be validated against a real, active `OrganizationMembership` row for `(user_id, organization_id)` — a tampered or stale org context in a request fails this check rather than being trivially true by construction. This pairs cleanly with the Row-Level Security recommendation in Decision 4: RLS policies key off the session's validated current-org, not off the User row directly.

**Roles / permissions**
Roles move from the User to the **membership**. `Mark → Sales + Dispatcher` (the multi-role example already locked in Workflow 1) becomes multi-role **on Mark's membership in a specific organization** — meaning Mark could plausibly be `Admin` in Organization A and `Dispatcher` in Organization B simultaneously, with no conflict, since permission resolution always happens against the current membership, never a global role set. The Compliance-approval permission (Workflow 3) and any future granular permissions attach to the membership the same way.

**Audit logs**
`AuditLog.actor_user_id` now references the **global** User — a person's identity is consistent across every organization they've ever acted in. Every audit entry still carries its own `organization_id` (already locked in every workflow's audit event design), so an organization's audit view is always filtered to its own entries only — a user who belongs to two orgs never causes one org to see the other's audit history. This is arguably a *cleaner* result than Model B: a person's full action history is attributable to one identity, while tenant isolation of visibility remains fully intact.

**Future Platform Operator / Super Admin access**
This model makes the already-locked Workflow 1 rule — "Super Admin does not automatically receive access to an organization's operational/financial data" — fall out naturally rather than needing a special case. The Super Admin is simply a `User` with **no `OrganizationMembership` at all** by default. If a future "support access" capability is built, it is literally just creating a scoped, audited, time-boxed `OrganizationMembership` for the Super Admin's existing identity — reusing the exact same mechanism every other user already goes through, rather than inventing a parallel access model.

**Stage 4 database design impact**
- `User` becomes a **global** table: no `organization_id` column; email is globally unique.
- A new `OrganizationMembership` entity carries what Workflow 1 originally modeled directly on `User`: status (Invited/Active/Inactive/Cancelled), roles, `invited_by`, `invited_at`, `activated_at`, `deactivated_at`, `deactivated_by` — these are properties of *this person's relationship to this org*, not of their global identity.
- Every existing foreign key that referenced "the acting user" (`assigned_dispatcher`, `account_owner`, `created_by`, `uploaded_by`, `approved_by`, etc.) points to `User.id` (global) directly — not to `OrganizationMembership.id` — since the underlying tables already carry their own `organization_id` for tenant scoping. The application layer must still verify an active membership exists for that `(user_id, organization_id)` pair before permitting any action; this is already required for permission-checking, so it's not new work, just worth naming.
- **Zero-Admin protection** (Workflow 1 §1.7) is reinterpreted as "at least one active `Admin`-role **membership** in this organization" rather than "active Admin users" — same rule, correctly rescoped.
- **Workflow 1 mechanics change slightly** (business outcomes do not): "Initial Admin Account Creation" now creates a `User` + `OrganizationMembership` together. "User Invitation" first checks whether a global `User` already exists for that email — if so, the invitation creates a **new `OrganizationMembership`** under the existing identity (no new password, no re-verification needed); if not, it creates both a new `User` and the `OrganizationMembership` together, and invitation-acceptance handles verification + password creation as today. All locked rules (7-day expiration, resend/cancel, zero-admin protection, no deletion — only deactivation) continue to hold, now scoped correctly to membership. I have **not** rewritten the locked Workflow 1 document — this note is here so Stage 4 knows the mapping; if you want Workflow 1 itself formally amended to reflect this, say so and I'll do it as a tracked change, not a silent edit.

### Exact decision locked
✅ `User` is a global identity. `OrganizationMembership` (user_id, organization_id, roles, status, invitation metadata) is the join entity carrying org-specific state. All role/permission checks resolve against the current membership. Platform Super Admin = a `User` with no default membership.

---

## Decision 2 — API Style: REST vs. GraphQL 🔒 LOCKED (accepted as recommended)

**Current recommendation:** REST, resource-oriented, versioned (`/api/v1/...`).

**Options**
| Option | Description |
|---|---|
| REST | Conventional resource endpoints (`/loads`, `/customers`, etc.) |
| GraphQL | Single flexible query endpoint, client specifies exact shape needed |

**Pros / Cons**
| | REST | GraphQL |
|---|---|---|
| Pros | Simpler tooling/caching/monitoring; better fit for a future public API where carriers/customers integrating expect conventional REST or EDI-style access, not GraphQL; easier to reason about permission-scoped responses per endpoint (Decision-4-style field redaction) | Naturally fits the Dispatch Board's nested, varying-shape data needs (Load + Stops + Documents + Carrier in different combinations per view) without endpoint proliferation |
| Cons | May require multiple round-trips or bespoke "expand" params for nested Dispatch Board views | Harder to enforce per-field permission redaction cleanly; unconventional for the future external-partner API audience; steeper operational learning curve for a small team |

**Impact on Stage 4:** Minimal direct schema impact either way — this affects the service/API layer, not table design. Slightly influences whether Stage 4 needs to optimize specific joined/nested read patterns.

**My recommendation:** REST (unchanged).

**Exact decision to lock:** Confirm REST as the internal (and eventually public) API style, with nested Dispatch Board data served via purpose-built "expanded" endpoints rather than a general query language.

---

## Decision 3 — Polymorphic Document Association 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Generic `entity_type` + `entity_id` columns on `Document`, rather than a separate join table per possible parent entity (Load, Stop, Customer, Carrier, Driver, Truck, Trailer, Invoice, Carrier Payment).

**Options**
| Option | Description |
|---|---|
| Generic polymorphic columns | One `Document` table; `entity_type` (enum/string) + `entity_id` identify the parent |
| Explicit join tables | e.g., `load_documents`, `carrier_documents`, one join table per entity type |

**Pros / Cons**
| | Polymorphic columns | Explicit join tables |
|---|---|---|
| Pros | One document system, matches the PRD's explicit "reusable, not per-entity" requirement; adding a new attachable entity type later needs no schema change | True foreign-key referential integrity per entity type; some ORMs/query planners handle explicit FKs more efficiently |
| Cons | No native FK constraint enforcing `entity_id` actually exists (must be enforced at the application layer) | Directly contradicts the PRD's explicit "one reusable document architecture" requirement; adding an entity type later requires a migration |

**Impact on Stage 4:** Directly determines the `Document` table's shape and whether referential integrity for the parent link is enforced at the DB or application layer.

**My recommendation:** Generic polymorphic columns (unchanged) — this is close to a locked requirement already, since PRD §9 explicitly rules out a per-entity document system.

**Exact decision to lock:** `Document.entity_type` + `Document.entity_id`, with application-layer validation that the referenced entity exists and belongs to the same organization.

---

## Decision 4 — Row-Level Security (RLS) as Defense-in-Depth 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Enforce tenant isolation at the application layer (every query scoped by `organization_id` from the validated session) **and** at the database layer via Postgres RLS policies.

**Options**
| Option | Description |
|---|---|
| Application-layer only | Every repository method filters by `organization_id`; discipline enforced by code review/testing |
| Application layer + RLS | Same as above, plus DB-enforced policies that reject any query without a matching org context, even if the application layer has a bug |

**Pros / Cons**
| | App-layer only | App-layer + RLS |
|---|---|---|
| Pros | Simpler; no RLS policy maintenance | A bug in one service's scoping logic cannot leak cross-tenant data — the database itself refuses; strong story for any future compliance/security review |
| Cons | A single missed `WHERE organization_id = ?` is a real cross-tenant data leak with no second line of defense | Adds policy definitions to maintain alongside schema changes; small performance overhead; requires the DB connection to carry session context (`SET app.current_org_id`) correctly |

**Impact on Stage 4:** If RLS is adopted, every tenant-scoped table needs its RLS policy defined alongside its schema (extra Stage 4 work), and the application's DB connection handling must reliably set the session's org context on every request.

**My recommendation:** Adopt RLS as defense-in-depth (unchanged) — given this is a multi-tenant system handling carrier banking/factoring details and customer financials, the extra Stage 4 effort is justified.

**Exact decision to lock:** Postgres RLS policies are in scope for Stage 4, applied to every table carrying `organization_id`, in addition to (not instead of) application-layer scoping.

---

## Decision 5 — Derived-Field Persistence Strategy 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Persist + recalculate-on-write for high-read-frequency derived fields (`Carrier.assignment_eligible`, `Load.pod_status`, `Load.status` from `DISPATCHED` onward); compute-at-read for low-frequency/cheap fields (`Invoice.status = OVERDUE`, which is a simple date comparison).

**Options**
| Option | Description |
|---|---|
| Persist all derived fields | Every derived value stored, recalculated on every relevant write |
| Compute all derived fields at read time | Nothing stored; always recalculated from source records on read |
| Mixed (chosen) | Persist where read-heavy, compute where cheap and read-light |

**Pros / Cons**
| | Persist all | Compute all at read | Mixed |
|---|---|---|---|
| Pros | Fast reads everywhere | No risk of stored value drifting from source truth; no recalculation triggers to maintain | Matches each field's actual access pattern; avoids both unnecessary write-side complexity and unnecessary read-side cost |
| Cons | More write-side logic (and audit events) to get right for every field, even rarely-read ones | Load-bearing screens (Dispatch Board, carrier assignment) recompute constantly — real performance cost at scale | Two different patterns to maintain/document (mitigated by the shared recalculation-utility approach in ARCHITECTURE.md §11) |

**Impact on Stage 4:** Persisted fields need their own column + an update path wired into every triggering workflow step; computed fields need none, but their computation logic must be centralized (e.g., a DB view or shared query function) so it isn't reimplemented inconsistently across reports/dashboards/API.

**My recommendation:** Mixed strategy (unchanged), exactly as specified per field in ARCHITECTURE.md §10–11.

**Exact decision to lock:** Persist: `assignment_eligible`, `pod_status`, `Load.status`. Compute-at-read: `Invoice` Overdue determination. No other fields assumed without Stage 4 review.

---

## Decision 6 — Money / Decimal Type Standard 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Fixed-point decimal type end-to-end (DB column, application type, API serialization) — never floating point.

**Options**
| Option | Description |
|---|---|
| `DECIMAL(12,2)` | Standard 2-decimal-place currency precision |
| `DECIMAL` with higher scale (e.g., `DECIMAL(14,4)`) | Extra precision for potential fractional-cent calculations (e.g., per-mile accessorial rates) |
| Floating point (`FLOAT`/`DOUBLE`) | Rejected outright — not a real option for financial data |

**Pros / Cons**
| | `DECIMAL(12,2)` | Higher-precision `DECIMAL` |
|---|---|---|
| Pros | Simple, matches how invoices/payments are actually displayed | Avoids rounding issues if a future per-mile or per-unit rate calculation needs sub-cent intermediate precision |
| Cons | Could round awkwardly if a future rate calculation (e.g., $/mile × fractional miles) needs more precision before final rounding | Slightly more storage; not obviously needed given no per-mile automatic calculation is in V1 scope (all rates are manually entered lump sums per Workflow 5 §5.2 — "dispatcher manually enters the negotiated carrier rate") |

**Impact on Stage 4:** Every monetary column across `Charge Line Item`, `Invoice`, `Payment`, `Carrier Payment`, `Adjustment`, etc. must use the same standard consistently.

**My recommendation:** `DECIMAL(12,2)` (unchanged, now made concrete) — V1 has no automatic per-unit rate math (all customer/carrier rates are manually entered per the locked workflows), so higher precision isn't currently justified; can be widened later without data loss if a future rate-calculation feature needs it.

**Exact decision to lock:** All monetary columns use `DECIMAL(12,2)`.

---

## Decision 7 — Audit Log Value Serialization 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Structured JSON for `previous_value`/`new_value` in the universal `AuditLog`.

**Options**
| Option | Description |
|---|---|
| Structured JSON | `previous_value`/`new_value` stored as JSON, shape varies per entity/field |
| Plain text | Human-readable string description only (e.g., "changed status from BOOKED to CARRIER_SOURCING") |
| Fully typed per-entity audit tables | A dedicated audit table per entity type with typed columns |

**Pros / Cons**
| | JSON | Plain text | Per-entity tables |
|---|---|---|---|
| Pros | Machine-readable and human-displayable; one table serves ~60+ distinct event types already named across Workflows 1–10 | Simplest to write | Strongest typing/queryability per entity |
| Cons | Slightly harder to query specific fields without JSON operators | Not machine-readable — can't programmatically diff/reconstruct state, weaker for future AI/reporting use | Explodes into dozens of tables, contradicts the PRD's "one reusable audit system" principle used consistently elsewhere |

**Impact on Stage 4:** Determines the `AuditLog` table's column design (a few structured columns + one/two JSON columns) versus a much larger table-per-entity design.

**My recommendation:** Structured JSON (unchanged) — Postgres's JSONB support (already a factor in the Decision 12 stack pick) makes this practical to query when needed while staying schema-agnostic across wildly different entity types.

**Exact decision to lock:** `AuditLog.previous_value` / `AuditLog.new_value` are JSONB columns; a single universal table, no per-entity audit tables.

---

## Decision 8 — Actor Model for AI/System Audit Entries 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Add `AuditLog.actor_type` (`human` / `system` / `ai`) now, even though only `human` and `system` are used in V1.

**Options**
| Option | Description |
|---|---|
| Add `actor_type` now | Column exists from Stage 4 onward, unused values simply don't occur yet |
| Add later, when AI is actually built | No schema change now; add the column (and a migration) when Priority-1 AI (document extraction) is eventually built |

**Pros / Cons**
| | Add now | Add later |
|---|---|---|
| Pros | Zero-cost placeholder; avoids a migration purely for this later; every future AI audit requirement in PRD §11 (capability, input/context, recommendation, human decision, final action) has a home from day one | Avoids adding an "unused" column to V1 schema |
| Cons | Marginal unused-column cost now | A later migration + backfill (defaulting existing rows to `human`) purely to support a feature explicitly deferred to a future phase |

**Impact on Stage 4:** One column, trivial either way — the only question is timing.

**My recommendation:** Add now (unchanged) — the cost asymmetry strongly favors doing this at initial schema design rather than as a later migration.

**Exact decision to lock:** `AuditLog.actor_type` enum (`human`, `system`, `ai`) included in the Stage 4 schema from the start.

---

## Decision 9 — File Storage Isolation (Org-Scoped Key Prefixes) 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Object storage keys prefixed by organization (e.g., `org_{id}/documents/{uuid}`), as isolation-in-depth alongside application-layer access control.

**Options**
| Option | Description |
|---|---|
| Org-scoped key prefixes | Storage layout physically partitioned by organization |
| Flat/global key namespace | All files in one namespace, isolation enforced purely by DB metadata + signed URLs |

**Pros / Cons**
| | Org-scoped prefixes | Flat namespace |
|---|---|---|
| Pros | Limits blast radius of a misconfigured bucket policy or an application bug that skips the permission check; makes future per-org export/deletion operations simpler | — |
| Cons | Marginal added complexity in key generation | A single storage-layer misconfiguration could expose all organizations' files, not just one |

**Impact on Stage 4:** Not a schema issue directly — affects the convention for `Document.storage_key` that Stage 4 will store as a column.

**My recommendation:** Org-scoped prefixes (unchanged).

**Exact decision to lock:** `Document.storage_key` follows an `org_{organization_id}/...` convention.

---

## Decision 10 — Malware / Virus Scanning on Upload 🔒 LOCKED

**Your decision:** Malware scanning is **required** in V1, not deferred. Files that fail scanning are **quarantined** (not deleted, not made available for download). The scanning provider/mechanism must be **replaceable** — i.e., the architecture must not hard-couple to a single vendor's SDK/API in a way that would require touching every call site to switch providers later.

**Implications for Stage 4:**
- `Document` gains a `scan_status` column: `PENDING` (just uploaded, not yet scanned) → `CLEAN` (safe, downloadable) → `INFECTED` (quarantined, no download) or `SCAN_FAILED` (scanner error — treated as blocked/quarantined until retried, not treated as clean-by-default).
- A document is **not downloadable via signed URL** (§8/§17 of ARCHITECTURE.md) until `scan_status = CLEAN`. This applies uniformly — no document type is exempt, including PODs and compliance documents.
- The scanning call itself happens as an **async background job** (§16 of ARCHITECTURE.md), not inline on the upload request — upload completes immediately with `scan_status = PENDING`, and a worker updates it shortly after. This keeps upload latency low and fits the existing background-job architecture rather than adding a new synchronous dependency to the request path.
- Provider replaceability is achieved by putting the scan call behind an internal interface (e.g., a `MalwareScanner` service contract) in the application layer — the `Document` schema itself only stores the **result** (`scan_status`, `scanned_at`, `scan_provider` for traceability), never anything provider-specific, so swapping providers never touches the schema.

**Exact decision locked:** Malware scanning is mandatory in V1 for every uploaded document. `Document.scan_status` (`PENDING`/`CLEAN`/`INFECTED`/`SCAN_FAILED`) gates download availability. Scanning runs async via a background job. The scanner integration sits behind an internal interface so the provider can be swapped without a schema or call-site change.

---

## Decision 11 — Backup / Retention & RPO/RTO Targets 🔒 LOCKED

**Your decision:** **RPO ≤ 24 hours, RTO ≤ 4 hours, backup retention ≥ 30 days.**

**Implications for Stage 4 / Stage 6:**
- RPO ≤24h means automated backups (or continuous WAL archiving, for Postgres) must run **at least daily**, though continuous/point-in-time recovery is preferable and easy to achieve with managed Postgres offerings — worth choosing a managed provider whose PITR window comfortably covers this target (Stage 6 decision, noted here since it's now a concrete requirement rather than an open question).
- RTO ≤4h means restore/failover tooling and process must be tested to reliably complete within 4 hours — this is primarily a Stage 6/22 (Deployment) concern, not a Stage 4 schema concern, but is recorded here as a locked constraint the infrastructure must be designed against.
- Retention ≥30 days means backups themselves must be retained at least 30 days — distinct from the earlier open question about audit-log/document retention, which remains indefinite by default (§18 of ARCHITECTURE.md) unless you decide otherwise later.

**Exact decision locked:** RPO ≤24h, RTO ≤4h, backup retention ≥30 days. Carried forward as a hard constraint into Stage 6 (Technical Architecture) infrastructure planning; no Stage 4 schema impact.

---

## Decision 12 — Technology Stack 🔒 LOCKED (accepted as recommended)

**Current recommendation:** Node.js + TypeScript (NestJS-style modular framework) backend, PostgreSQL, React + TypeScript frontend, S3-compatible object storage, Redis-backed job queue, in-app session-based auth.

**Options:** (see ARCHITECTURE.md §21 for the full comparison basis — not re-litigated here since no new information has emerged)

**Impact on Stage 4:** PostgreSQL specifically is what makes Decisions 4 (RLS), 6 (DECIMAL type), and 7 (JSONB) practical exactly as recommended — if a different database were chosen, those three decisions would need to be revisited.

**My recommendation:** Unchanged from ARCHITECTURE.md §21.

**Exact decision to lock:** Confirm PostgreSQL specifically (given Decisions 4/6/7 depend on it) and the general backend/frontend language direction, understanding Stage 6 will finalize exact framework versions and hosting specifics.

---

## Summary Table

| # | Decision | Status |
|---|---|---|
| 1 | User Identity — Global User + OrganizationMembership | 🔒 LOCKED |
| 2 | API Style — REST | 🔒 LOCKED |
| 3 | Polymorphic Document Association | 🔒 LOCKED |
| 4 | Row-Level Security (defense-in-depth) | 🔒 LOCKED |
| 5 | Derived-Field Persistence Strategy | 🔒 LOCKED |
| 6 | Money/Decimal Standard — `DECIMAL(12,2)` | 🔒 LOCKED |
| 7 | Audit Log Serialization — JSONB | 🔒 LOCKED |
| 8 | Actor Model (`actor_type`) — add now | 🔒 LOCKED |
| 9 | File Storage Isolation — org-scoped prefixes | 🔒 LOCKED |
| 10 | Malware Scanning on Upload — required, quarantine, replaceable provider | 🔒 LOCKED |
| 11 | Backup/Retention — RPO ≤24h, RTO ≤4h, retention ≥30d | 🔒 LOCKED |
| 12 | Technology Stack | 🔒 LOCKED |

---

**All 12 decisions are now locked.** Stage 4 (Database Design) proceeds in [docs/DATABASE_DESIGN.md](DATABASE_DESIGN.md).
