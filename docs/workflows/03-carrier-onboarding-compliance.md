# Workflow 3: Carrier Onboarding & Compliance
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md)

## Actors
| Actor | Description |
|---|---|
| **Onboarding User** | Admin, Operations Manager, or Dispatcher — creates and manages Carrier records |
| **Compliance Reviewer** | Authorized user with the distinct Compliance-approval permission (may overlap with Admin/Ops Manager, but the *permission* is separate from carrier-creation permission) |
| **System** | The TMS application (validation, eligibility calculation, notifications, audit logging) |

## Trigger
An Onboarding User needs to add a new carrier to the network — typically triggered by a dispatcher sourcing a load and finding an unlisted carrier, or proactive network-building by Operations.

## Preconditions
- Acting user is Active and holds Admin, Operations Manager, or Dispatcher role (for creation).
- A separate Compliance-reviewer permission exists and is assigned to at least one user in the organization for document approval and activation steps.

---

## 3.1 Carrier Creation

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | Initiates "Create Carrier" | — | — |
| 2 | Enters legal name, DBA (if applicable), MC number, DOT number, physical address, primary contact name/phone/email | — | — |
| 3 | Submits form | — | Validates required fields present and well-formed |
| 4 | — | — | Runs **MC/DOT duplicate check** (see 3.2) |
| 5 | — | — | If no conflict: creates `Carrier` record, status = `PENDING`, assignment_eligible = `NO` |
| 6 | — | — | Writes audit event: `Carrier Created` |

**Required Fields:** Legal name, DBA (if applicable), MC number, DOT number, physical address, primary contact name/phone/email.
**Not required at creation:** Carrier Agreement, W9, COI, MC Authority, insurance records, FMCSA verification, factoring info — all addable afterward.

**System Validations**
- Required fields present and non-empty.
- MC number and DOT number each pass uniqueness check (3.2).
- Onboarding user's role is Admin, Operations Manager, or Dispatcher.

**Status Assignment:** New Carrier always starts at `PENDING`, with `assignment_eligible = NO` by definition (no compliance items satisfied yet).

**Data Created:** `Carrier` record: organization_id, legal_name, dba, mc_number, dot_number, address, primary_contact, status = Pending, assignment_eligible = No, created_by, created_at.

**Documents Generated:** None
**Notifications:** None specified for creation itself
**Audit Events:** `Carrier Created` (actor: Onboarding User)

**Completion Criteria:** `Carrier` record exists with status `PENDING`, required identity fields populated, ready to receive compliance documents.

---

## 3.2 MC/DOT Duplicate Validation

**Trigger:** Occurs within Step 4 above, before save
**Matching Signals:** MC number (exact match), DOT number (exact match), scoped to the organization

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | — | Checks MC number and DOT number against existing Carriers in the organization |
| 2a | — | — | If no match on either: proceeds to save (3.1, Step 5) |
| 2b | — | — | If match found on MC and/or DOT: **blocks creation** (hard failure, not a warning) |
| 3 | Views error identifying the conflict; if permitted, is shown a link to the existing matching Carrier | — | Writes audit event: `Carrier Creation Blocked — Duplicate MC/DOT` |

**Nature of Check:** Hard block — unlike Customer duplicate detection, this cannot be overridden. MC/DOT numbers must be unique per organization.

**Completion Criteria:** Either the new Carrier is created (no duplicate), or creation is blocked with a clear reference to the conflicting existing record.

---

## 3.3 Compliance Document Upload

**Trigger:** Onboarding User (or any user with Carrier document-upload access) uploads a required compliance document
**Preconditions:** Carrier record exists

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | Selects document type (W9, COI, Carrier Agreement, MC Authority, or other) and uploads file | — | — |
| 2 | — | — | Validates file type/size; creates `Document` record associated with Carrier, status = `Uploaded` |
| 3 | — | — | Immediately transitions document status: `Uploaded` → `Pending Review` |
| 4 | — | — | Writes audit event: `Compliance Document Uploaded` |
| 5 | — | — | Notifies Compliance Reviewers that a document is awaiting review |

**Required Document Types (for eligibility):** W9, COI, Carrier Agreement, MC Authority.
**Other document types** (factoring NOA, etc.) may also be uploaded but do not gate eligibility (see 3.6/3.10).

**Data Created:** `Document` record: entity = Carrier, type, file, version = 1, status = Pending Review, uploaded_by, uploaded_at.
**Documents Generated:** None (this step is upload, not generation)
**Notifications:** Compliance Reviewers notified of pending document
**Audit Events:** `Compliance Document Uploaded` (actor: uploader)

**Completion Criteria:** Document exists in `Pending Review` status, visible to Compliance Reviewers.

---

## 3.4 Compliance Document Review (Approve / Reject)

**Trigger:** Compliance Reviewer opens a document in `Pending Review`
**Preconditions:** Acting user holds Compliance-approval permission **and** is not the original uploader of this specific document

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | Opens pending document, reviews content | — |
| 2 | — | — | Verifies reviewer ≠ uploader for this document; if reviewer is the uploader, **blocks approval action** |
| 3a | — | Selects "Approve" | Transitions document status: `Pending Review` → `Approved`; records reviewed_by, reviewed_at |
| 3b | — | Selects "Reject", enters rejection reason (required) | Transitions document status: `Pending Review` → `Rejected`; records reviewed_by, reviewed_at, rejection_reason |
| 4 | — | — | Writes audit event: `Compliance Document Approved` or `Compliance Document Rejected` |
| 5 | — | — | Recalculates Assignment Eligibility (see 3.8) |
| 6 | Notified of approval/rejection outcome | — | Sends notification to Onboarding User / Carrier owner |

**System Validations**
- Reviewer must hold Compliance-approval permission.
- Reviewer must not be the uploader of this document (self-approval blocked).
- Rejection requires a non-empty reason.

**Status Transitions (Document):** `Pending Review` → `Approved` | `Rejected`
**Data Updated:** `Document.status`, `reviewed_by`, `reviewed_at`, `rejection_reason` (if rejected)
**Audit Events:** `Compliance Document Approved` / `Compliance Document Rejected` (actor: Compliance Reviewer)
**Handoff:** Rejected documents remain visible in Carrier history; a corrected version can be uploaded as a new document/version, re-entering this review cycle.

**Exceptions**
- Uploader attempts self-approval → blocked, error shown ("You cannot approve a document you uploaded. Another Compliance reviewer must approve it.").
- Reviewer rejects without reason → submission blocked until reason provided.

**Completion Criteria:** Document reaches a terminal `Approved` or `Rejected` state; eligibility recalculation has run.

---

## 3.5 FMCSA / SAFER Verification (Manual)

**Trigger:** Compliance Reviewer manually performs external FMCSA/SAFER lookup and records the result
**Preconditions:** Carrier record exists

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | Looks up carrier externally via FMCSA/SAFER | — |
| 2 | — | Enters verification date, result/status (e.g., Authorized, Not Authorized, Out of Service), verified-by (self), relevant authority info, notes | — |
| 3 | — | Submits | Validates required fields (date, result/status) present |
| 4 | — | — | Saves `FMCSA Verification` record; writes audit event: `FMCSA Verification Recorded` |
| 5 | — | — | Recalculates Assignment Eligibility (see 3.8) |

**Data Created:** `FMCSA Verification` record: carrier_id, verification_date, result/status, verified_by, authority_info, notes.
**Audit Events:** `FMCSA Verification Recorded` (actor: Compliance Reviewer)

**Completion Criteria:** Carrier has at least one FMCSA/SAFER verification record with an acceptable result; feeds into eligibility calculation.

---

## 3.6 Insurance Recording & Validation

**Trigger:** Onboarding User or Compliance Reviewer adds/updates insurance information, typically alongside COI document upload
**Preconditions:** Carrier record exists

**COI / Coverage relationship:** The **COI (Certificate of Insurance) is a supporting document** (tracked as a `Document` record like any other compliance document). **Auto Liability** and **Cargo** are separate **structured `Carrier Insurance` coverage records**, each holding coverage amount, effective date, expiration date, insurer, and agent — kept distinct from the `Document` record so these fields are properly queryable and don't depend on parsing an uploaded file. A single COI document may support one or both coverage records (e.g., one certificate listing both Auto Liability and Cargo limits) — each `Carrier Insurance` record links to its supporting COI `Document`. Eligibility independently verifies that **both** required coverage types exist, are within their (structured) expiration date, and have an **Approved** supporting COI document — a single approved COI does not automatically satisfy both coverage types unless both structured coverage records reference it and are individually valid.

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | Enters insurance record: coverage type (Auto Liability or Cargo), coverage amount, insurance company, agent/contact, effective date, expiration date; links the associated COI document | — | — |
| 2 | Submits | — | Validates required fields present; validates expiration date is after effective date |
| 3 | — | — | Saves `Carrier Insurance` record (structured, separate from the `Document` record) |
| 4 | — | Reviews and approves/rejects the associated COI document per 3.4 | — |
| 5 | — | — | Recalculates Assignment Eligibility (see 3.8) |

**Mandatory Coverage Types for Eligibility:** Auto Liability, Cargo (both required, each as its own structured record).
**Data Created:** `Carrier Insurance` record: carrier_id, coverage_type, coverage_amount, insurance_company, agent_contact, effective_date, expiration_date, associated_document_id (COI).
**Audit Events:** `Carrier Insurance Added/Updated` (actor: entering user)

**Completion Criteria:** Both Auto Liability and Cargo insurance records exist with valid (non-expired, per `Carrier Insurance.expiration_date`) dates and each links to an Approved COI document, in order to satisfy eligibility.

---

## 3.7 Carrier Activation (PENDING → ACTIVE)

**Trigger:** Compliance Reviewer initiates "Activate Carrier"
**Preconditions:** Carrier status = `PENDING`

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | Selects "Activate Carrier" | — |
| 2 | — | — | Evaluates full Assignment Eligibility rule set (3.8) against current data |
| 3a | — | — | If all requirements satisfied: allows activation to proceed |
| 3b | — | — | If any requirement unsatisfied: **blocks activation**, lists unmet requirement(s) |
| 4 | — | Confirms activation (only reachable if 3a) | Transitions Carrier status: `PENDING` → `ACTIVE`; sets `assignment_eligible = YES`; writes audit event `Carrier Activated` |

**System Validations:** All Assignment Eligibility conditions (3.8) must be satisfied at the moment of activation. Activation is **never automatic** — even if every requirement happens to be satisfied, an authorized Compliance Reviewer must take the explicit activation action.

**Status Transitions (Carrier):** `PENDING` → `ACTIVE`
**Audit Events:** `Carrier Activated` (actor: Compliance Reviewer)

**Exceptions**
- Compliance Reviewer attempts activation with unmet requirements → blocked, system lists exactly which items are missing/unapproved/expired.

**Completion Criteria:** Carrier status = `ACTIVE` and assignment_eligible = `YES`, both explicitly confirmed by a Compliance Reviewer action.

---

## 3.8 Assignment Eligibility Calculation (cross-cutting rule, re-run on every relevant change)

**Trigger:** Any of: document approval/rejection, document/insurance expiration, insurance record change, FMCSA verification recorded, Carrier status change, or a scheduled daily expiration sweep.

**Rule (all conditions required for `assignment_eligible = YES`):**
1. Carrier status = `ACTIVE`
2. Carrier Agreement document = `APPROVED`
3. W9 document = `APPROVED`
4. Auto Liability `Carrier Insurance` record = linked to an `APPROVED` COI document, and `expiration_date` not passed
5. Cargo `Carrier Insurance` record = linked to an `APPROVED` COI document, and `expiration_date` not passed
6. MC Authority document = `APPROVED`
7. FMCSA/SAFER verification = completed with an acceptable result

If **any** condition fails, `assignment_eligible = NO` and the system records the specific failing reason(s) (e.g., "Cargo insurance expired," "MC Authority not yet approved").

A **Blocked** Carrier (see 3.12) is always `assignment_eligible = NO` regardless of how many of the above conditions are otherwise satisfied.

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | — | Recalculates eligibility whenever a triggering event occurs |
| 2 | — | — | Updates `Carrier.assignment_eligible` and `Carrier.ineligibility_reasons[]` |
| 3 | — | — | If eligibility changed (YES↔NO), writes audit event `Assignment Eligibility Changed` with reason(s) |
| 4 | — | — | Surfaces current eligibility + reasons clearly on the Carrier record and in carrier-sourcing/assignment screens |

**Key principle:** Assignment Eligibility is tracked **separately from Carrier Status**. An expired compliance item never automatically changes Carrier Status (`ACTIVE` stays `ACTIVE`); it only flips `assignment_eligible` to `NO`.

**Enforcement:** The system blocks assignment of any Carrier with `assignment_eligible = NO` to a new load (enforced at the point of assignment in the future Dispatch/Carrier Sourcing workflow — referenced here, not redefined).

**Completion Criteria:** `Carrier.assignment_eligible` always accurately reflects current compliance state; reasons are visible wherever the Carrier can be selected for assignment.

---

## 3.9 Expiration Handling & Recalculation

**Trigger:** A required document's or insurance record's expiration date passes (evaluated via scheduled system check, e.g., daily). Expiration is only ever evaluated for items that **have an applicable expiration date** — a document/record with no expiration date defined is never auto-expired by this process.

**Source of truth for expiration:**
- Document-type items with an expiration date (e.g., MC Authority, Carrier Agreement, if applicable) use the `Document.expiration_date` field on that document record.
- **Insurance specifically uses `Carrier Insurance.expiration_date`** (the structured coverage record) — never inferred or parsed from the uploaded COI file itself. The COI document's own approval status is a separate, additional condition (3.6), but the expiration clock for insurance eligibility runs off the structured field.

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | — | Scheduled process identifies compliance items past their applicable expiration date |
| 2 | — | — | Marks the specific document status as `Expired` (documents with an expiration date), or flags the `Carrier Insurance` record as expired (insurance) |
| 3 | — | — | Recalculates Assignment Eligibility (3.8) — Carrier remains `ACTIVE`; `assignment_eligible` becomes `NO` if this was a required item |
| 4 | — | — | Writes audit event: `Compliance Item Expired` |
| 5 | Notified (if applicable per role) | Notified | Sends expiration notifications (see 3.10) |
| 6 | Uploads replacement document / updates insurance record | Reviews and approves replacement (3.4/3.6) | Recalculates eligibility again; if all requirements now satisfied, `assignment_eligible` returns to `YES` — **without altering historical records** of the prior expiration/rejection |

**Status Transitions:** Document: `Approved` → `Expired` (time-based, system-driven, only where an expiration date applies). Carrier Insurance: flagged expired based on its own `expiration_date`. Carrier status: unchanged (remains `ACTIVE`).
**Audit Events:** `Compliance Item Expired` (system-generated), `Assignment Eligibility Changed` (from 3.8)

**Completion Criteria:** Expired items are clearly flagged (based on their own applicable expiration data), eligibility is accurately recalculated, and replacement documents/updated insurance restore eligibility through the normal review cycle without erasing history.

---

## 3.10 Expiration Notifications

**Trigger:** Scheduled system check identifies a required compliance item (with an applicable expiration date) approaching expiration
**Thresholds:** 30 days, 15 days, and 7 days before expiration (each fires once)

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | — | — | Scheduled process scans required compliance items (Auto Liability / Cargo `Carrier Insurance.expiration_date`, and any document types with an applicable expiration date such as MC Authority, Carrier Agreement) for upcoming expiration at the 30/15/7-day thresholds |
| 2 | — | — | Generates notification identifying: Carrier, item type, expiration date, current assignment eligibility |
| 3 | Receives notification (Operations Manager) | Receives notification (Compliance) | Delivers via in-app notification system (per existing V1 notification capability) |

**Recipients:** Compliance users, Operations Managers.
**Audit Events:** `Expiration Notification Sent` (system-generated, per threshold per item)

**Completion Criteria:** Relevant users are warned at each threshold before an item lapses, giving time to secure a renewal before eligibility is lost.

---

## 3.11 Factoring Information (Informational Only)

**Trigger:** Onboarding User or Carrier contact provides factoring details, at onboarding or any time later
**Preconditions:** Carrier record exists

| Step | Onboarding User | Compliance Reviewer | System |
|---|---|---|---|
| 1 | Enters factoring company, remit-to info, factoring status, NOA status, uploads NOA document (if applicable) | — | — |
| 2 | Submits | — | Saves `Carrier Factoring Info`; if NOA document uploaded, creates `Document` record (type = Factoring NOA) |
| 3 | — | — | Writes audit event: `Factoring Information Updated` |

**Note:** Factoring status has **no effect on Assignment Eligibility** in V1 — it is purely informational, to be used by a future carrier-pay/factoring routing workflow.

**Completion Criteria:** Factoring details are on file and visible on the Carrier record when applicable; no eligibility impact.

---

## 3.12 Carrier Status Reference (for this workflow's scope)

| Status | Set By | Scope |
|---|---|---|
| `PENDING` | System, at creation (3.1) | This workflow |
| `ACTIVE` | Compliance Reviewer, via explicit activation (3.7) | This workflow |
| `INACTIVE` | *(not defined in this workflow)* | Future Carrier Management workflow |
| `BLOCKED` | *(not defined in this workflow)* | Future Carrier Management workflow |

**Note:** `BLOCKED` is an administrative carrier lifecycle state handled by a separate future **Carrier Management** workflow — it is not part of onboarding. Regardless of which workflow sets it, **a `BLOCKED` Carrier must always be `assignment_eligible = NO`**, overriding any otherwise-satisfied compliance conditions (see 3.8).

---

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Carrier Created` | Onboarding User |
| `Carrier Creation Blocked — Duplicate MC/DOT` | System (automatic) |
| `Compliance Document Uploaded` | Uploading User |
| `Compliance Document Approved` / `Compliance Document Rejected` | Compliance Reviewer |
| `Carrier Insurance Added/Updated` | Entering User |
| `FMCSA Verification Recorded` | Compliance Reviewer |
| `Carrier Activated` | Compliance Reviewer |
| `Assignment Eligibility Changed` | System (automatic, with reasons) |
| `Compliance Item Expired` | System (automatic, scheduled) |
| `Expiration Notification Sent` | System (automatic, scheduled) |
| `Factoring Information Updated` | Onboarding User |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Duplicate MC or DOT number | Hard block at creation, existing record referenced |
| Uploader attempts to approve own document | Blocked with explanation |
| Rejection without reason | Blocked until reason entered |
| Activation attempted with unmet requirements | Blocked, unmet items listed |
| Required document/insurance expires | Carrier stays Active, eligibility flips to No, reason shown, notifications fire |
| Compliance item corrected/re-approved | Eligibility recalculated back to Yes; expiration/rejection history preserved, not erased |
| Carrier is Blocked (future workflow) | Always assignment-ineligible, regardless of otherwise-satisfied conditions |

---

*Locked as part of Stage 2 — Business Workflows. Defines Carrier creation, MC/DOT duplicate blocking, compliance document upload/review with mandatory reviewer/uploader separation, structured (non-document) insurance coverage tracking for Auto Liability and Cargo, manual FMCSA/SAFER verification, explicit (never automatic) activation, the Assignment Eligibility calculation kept independent of Carrier Status, expiration handling driven by structured expiration fields, and tiered expiration notifications. INACTIVE and BLOCKED status transitions belong to a future Carrier Management workflow.*
