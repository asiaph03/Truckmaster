# Product Requirements Document (PRD)
## Transportation Management System (TMS)

**Status:** Draft v1.0 — Requirements Locked, Pre-Architecture
**Stage:** 1 of 9 (Product Requirements Document)
**Next Stage:** Business Workflows

---

## 1. V1 Scope

### 1.1 Business Model
- **Multi-tenant SaaS** from day one. Even though initial deployment serves one company, the architecture must isolate data per **Organization** and support many independent organizations.
- Primary business model: **Freight Brokerage / 3PL** (non-asset). The organization does not operate its own fleet in V1.
- Core V1 workflow:
  `Customer → Load → Carrier Sourcing → Carrier Assignment → Dispatch → Pickup → Tracking → Delivery → POD → Customer Invoice → Carrier Pay → Closed`

### 1.2 Freight Modes & Equipment (V1)
- **Mode:** Full Truckload (FTL) only.
- **Equipment types:** Dry Van, Reefer, Flatbed.
- **Geography:** United States domestic only. No cross-border (Canada/Mexico) or international. Currency: USD only.

### 1.3 Scale Target
- Design for ~100–500 loads/day, hundreds to thousands of carriers, multiple users per organization.
- Architecture should be scalable beyond this, but no premature optimization for millions of loads.

### 1.4 V1 Feature Summary
| Area | V1 Status |
|---|---|
| Multi-stop loads | ✅ Full support |
| Quote → Booked workflow | ✅ Quote optional, expiration + win/loss tracking |
| Manual carrier sourcing | ✅ In-app recording, no automated broadcast |
| Rate Confirmation generation | ✅ Generated + emailed from system |
| Lightweight Driver/Truck/Trailer records (carrier-linked) | ✅ Reusable at dispatch |
| Manual tracking (check calls, location, ETA, at-risk flag) | ✅ Full structured support |
| Document management (upload, versioning, types, Document Center) | ✅ Full support |
| Customer & carrier rate history | ✅ Data model + basic usage |
| Customer invoicing (individual + consolidated) | ✅ Manual generation/approval |
| Carrier pay (multi-payment, approval workflow) | ✅ Full support |
| Profitability (per load, aggregable) | ✅ Full support |
| AR / AP aging | ✅ Full support |
| Role-based dashboards & core reports | ✅ Full support |
| Load search/export (CSV/Excel) | ✅ Full support |
| Bulk CSV/Excel import (customers, carriers, drivers, equipment) | ✅ Full support |
| Transactional email (rate con, invoice sending) | ✅ Full support |
| Audit trail | ✅ Full support, all financially/operationally significant actions |

---

## 2. Explicitly Deferred Features (Post-V1)

These are **out of scope for V1** but the architecture must not preclude them. Each should remain addressable without a data-model rewrite.

| Feature | Notes |
|---|---|
| Customer portal | Data model ready: Organization → Customer → Customer Users |
| Carrier portal | Data model ready: Organization → Carrier → Carrier Users |
| Driver portal / driver app | Not designed yet beyond lightweight driver record |
| Full fleet / asset management (own trucks & drivers) | Future: Organization → Own Fleet → Drivers/Trucks/Trailers, parallel to Carrier Network path |
| Driver compliance (CDL, medical card, HOS, ELD, drug/alcohol) | Future fields noted in Section 4 |
| Truck/trailer compliance (registration, inspection, maintenance, insurance) | Future fields noted in Section 4 |
| GPS / ELD tracking integration | Priority 2 future integration (Samsara, Motive, Project44, MacroPoint, etc.) |
| Automated FMCSA/SAFER verification | Manual in V1; integration-ready data model |
| Automated carrier broadcasting / bidding | Manual sourcing only in V1 |
| Multi-carrier loads (split across carriers) | Data model should not block this later; V1 = one carrier per load |
| Customer credit limit/hold enforcement | Fields reserved on customer record; no enforcement logic in V1 |
| E-signature on rate confirmations | V1 = generate + email only |
| OCR / AI document extraction | Priority 1 AI roadmap item |
| AI rate intelligence | Priority 2 AI roadmap item |
| AI carrier selection | Priority 3 AI roadmap item |
| AI copilot (conversational assistant) | Priority 4 AI roadmap item |
| AI exception/risk detection | Priority 5 AI roadmap item |
| AI forecasting & advanced analytics | Priority 6 AI roadmap item |
| Load board integrations (DAT, Truckstop) | Priority 3 integration; V1 only tracks "posted externally" placeholder fields |
| EDI (204/210/214/990) | Future; no near-term demand |
| Public API | Future; internal service boundaries should anticipate it |
| Outbound webhooks | Future; internal event model should anticipate it |
| Accounting system integration (QuickBooks, etc.) | Priority 1 integration; V1 finance is self-contained |
| Google Sheets integration | Future; V1 uses CSV/Excel import-export instead |
| Inbound email processing | Future/AI-era feature |
| Tax engine | Out of scope for V1 |
| Scheduled/emailed reports | Future; on-demand only in V1 |
| Carrier batch settlement runs | V1 supports per-load/per-payment settlement documents only |
| Full carrier performance scorecards (UI) | V1 retains all underlying data; scorecard UI is future |

---

## 3. User Roles

### 3.1 Internal Roles (V1)
- **Admin** — full organizational access and configuration.
- **Operations Manager** — organization-wide operational visibility, workload oversight across dispatchers.
- **Dispatcher** — manages assigned loads ("My Loads"), carrier sourcing, dispatch, tracking, communication.
- **Sales / Booking** — creates leads/quotes/bookings, owns customer relationships, sees sales metrics.
- **Accounting** — invoicing, payments, AR/AP, carrier pay approval, financial reporting.

### 3.2 External Roles (Architecture-Ready, Not Implemented in V1)
- **Customer** (via future Customer Portal)
- **Carrier** (via future Carrier Portal)
- **Driver** (via future driver-facing access)

### 3.3 Permission Principles
- Permissions are role-based with room to grow toward granular permission sets.
- Financial data (customer revenue, carrier cost, gross profit, margin, invoices, payments, AR/AP) is **not** visible to Dispatchers by default; visibility is governed by role/permission, enforced at both dashboard and report level.
- Every user's data access is scoped to their Organization; cross-organization access is never implicit.

---

## 4. Core Entities

**Organization-scoped (multi-tenant root):** every entity below belongs to exactly one Organization unless noted.

- **Organization** — tenant root.
- **User** — internal user, has one or more roles.
- **Customer** — shipper/account. Has: legal name, billing address, status (Prospect/Active/Inactive/Blocked), account owner, payment terms (org default, overridable per customer), credit fields (reserved for future enforcement: credit limit, current balance, credit status, hold reason).
  - **Customer Location** — reusable pickup/delivery address book entry (name, address, type, contact, hours, appointment requirements, notes).
  - **Customer Contact** — multiple, with roles (Booking, Operations, Billing, Management, Other), primary flag.
  - **Customer Rate Agreement** — lane-based negotiated rates (origin, destination, equipment, rate, rate type, effective/expiration dates, fuel surcharge rules, notes).
- **Carrier** — MC/DOT identity, address, status (Pending/Active/Inactive/Blocked), assignment eligibility state.
  - **Carrier Contact** — multiple, with roles (Dispatch, Safety/Compliance, Billing, Factoring, Management, Other), primary flag.
  - **Carrier Compliance Document** — W9, COI, Carrier Agreement, MC Authority, Factoring NOA, other; review state (Uploaded/Pending Review/Approved/Rejected/Expired); expiration tracking.
  - **Carrier Insurance** — type (Auto Liability, Cargo, extensible), coverage amount, policy #, effective/expiration dates, agent contact, document.
  - **Carrier FMCSA/SAFER Verification** — manual record: date, authority status, safety status, notes, verified by.
  - **Carrier Equipment/Lane Profile** — equipment types operated, preferred lanes/regions (simple tagging).
  - **Carrier Rate History** — historical paid rates by lane (derived from load records).
  - **Carrier Factoring Info** — uses factoring (Y/N), factoring company, remit-to address, contact, payment instructions, NOA status/document.
  - **Driver** (lightweight, carrier-linked) — name, phone, email, license #, notes, active/inactive. *(Future compliance fields: CDL class/expiration, medical card/expiration, HOS, ELD, drug & alcohol records.)*
  - **Truck** (lightweight, carrier-linked) — unit #, type, make/model, year, VIN, plate, active/inactive, notes. *(Future: registration, inspection, maintenance, insurance, compliance.)*
  - **Trailer** (lightweight, carrier-linked) — unit #, type, VIN, plate, active/inactive, notes. *(Future: registration, inspection, maintenance, compliance.)*
- **Load** — the central transactional entity (see Section 5 for lifecycle detail).
  - **Stop** — sequence, type (pickup/delivery/other), location, address, appointment date/time, actual arrival/departure, contact info, notes, status.
  - **Reference Numbers** — customer PO #, BOL #, pickup #, customer reference # (separate structured fields).
  - **Dispatch Record** — assigned carrier, driver (snapshot), truck (snapshot), trailer (snapshot) — snapshotted at dispatch time so historical accuracy is preserved even if the carrier's underlying records later change.
  - **Charge Line Item** — customer-side (revenue) and carrier-side (cost); type, description, quantity, unit rate, amount, source, notes.
  - **Check Call** — date/time, user, contact method, person contacted, location (city/state), ETA, on-time status, at-risk status, notes.
  - **Tracking/Location Snapshot** — current/last-known location, timestamp, source (manual now, GPS/ELD-ready later).
  - **Risk Status** — Normal / At Risk / Delayed + reason, independent of primary load Status.
  - **Activity/Communication Log entry** — activity type, user, date/time, notes, related entities.
  - **Internal Note** — author, timestamp, content.
  - **External Posting Record** — posted (Y/N), date/time, platform, status, notes (placeholder for future load board integration).
  - **Status History** — full audit of status transitions (previous, new, user, timestamp, reason).
- **Quote** — pre-booking record: customer, lane, equipment, rate, expiration date, won/lost outcome.
- **Document** — polymorphic attachment to Load, Customer, Carrier, Driver, Truck, Trailer, Invoice; type (predefined + org-custom), version history, current-version flag.
- **Invoice** — individual or consolidated (multiple loads), status (Draft/Sent/Partially Paid/Paid/Overdue/Void/Credited), sequential invoice number (`INV-000001`), line items, due date (derived from payment terms).
  - **Payment** — amount, date, method, reference #, notes, recorded by (supports multiple partial payments per invoice).
  - **Credit/Debit Adjustment** — amount, reason, date, user, related invoice, notes.
- **Carrier Payment** — amount, date, method, status, reference #; supports multiple payments per load (deposit/partial/balance/adjustment); approval workflow (Draft → Pending Approval → Approved → Paid).
- **Carrier Settlement Document** — generated summary of carrier charges, accessorials, adjustments, total, payment info (per-payment, not batched).
- **Notification** — type, recipient user, related entity, read/unread, channel (in-app in V1).
- **Saved Report View** — user-defined filter set saved for reuse against existing report templates.
- **Import Batch** — bulk CSV/Excel import job: entity type, file, mapping, validation results, summary (success/warnings/errors).
- **Audit Log Entry** — universal: organization, user, timestamp, action, entity, previous value, new value, reason (when applicable).

---

## 5. Load Lifecycle

### 5.1 Primary Status Flow
```
REQUEST / LEAD (optional)
   → QUOTE (optional, expirable, won/lost tracked)
   → BOOKED
   → CARRIER SOURCING
   → CARRIER ASSIGNED
   → RATE CONFIRMATION (generated/sent)
   → DISPATCHED (driver/truck/trailer captured)
   → PICKUP
   → IN TRANSIT
   → DELIVERED
   → POD RECEIVED
   → CUSTOMER INVOICED
   → CARRIER PAY
   → CLOSED
```

### 5.2 Rules
- **Quote stage is optional** — authorized Sales/Ops users may create a load directly as BOOKED for known/repeat business.
- **Quote → Booked** requires internal Sales/Ops confirmation in V1 (no customer self-service acceptance yet).
- **Carrier Sourcing** is manual: dispatcher works the phone/email outside the system and records the selected carrier in-app. No automated broadcast/bid in V1.
- **One carrier per load** in V1; architecture should not preclude future multi-carrier/split loads.
- **Carrier rejection**: if an assigned carrier backs out, load returns to CARRIER SOURCING; the rejection event + reason is recorded in the audit/activity history.
- **Rate Confirmation** is system-generated from load + carrier rate data, attached to the load, and can be emailed directly from the system. E-signature is future.
- **Dispatch** captures driver name/phone, truck #, trailer # — selectable from reusable carrier-linked records or entered manually; values are snapshotted onto the load/dispatch record.
- **Pickup/Delivery** stops track both scheduled appointment and actual arrival/departure.
- **Tracking (In Transit)** is manual via structured Check Calls (Section on Tracking).
- **POD** is an important milestone but does **not hard-block** invoicing — the system warns if invoicing is attempted without a POD on file.
- **Customer Invoicing** is never auto-triggered by POD; Accounting manually reviews and creates/sends the invoice.
- **Carrier Pay** is manually recorded (amount, date, method, status, reference), subject to an approval workflow (Draft → Pending Approval → Approved → Paid) before payment is recorded.
- **Closing a load is a manual, final action.** The system shows a readiness checklist (Rate Confirmation, POD, Customer Invoice, Carrier Pay Recorded) and warns — but does not block — closing when items are missing. Manual override is logged.
- **Status transitions are not rigid.** Authorized users may move a load forward or backward when operations require it (e.g., carrier backs out → return to CARRIER SOURCING). Invalid/unusual transitions require a reason or trigger a warning. Full status history is retained.
- **Rates are never overwritten.** The original agreed customer/carrier rate is preserved permanently; all changes are represented as additional charge line items/adjustments (detention, layover, lumper, TONU, additional stop, re-delivery, other accessorial).

### 5.3 Future Exception States (data model should anticipate, not fully implement in V1)
Cancelled, TONU, Detention, Layover, Lumper, No-show, Carrier Rejected (partially implemented — see above), Re-dispatched, Delivery Issue.

---

## 6. Core Workflows

### 6.1 Quoting & Booking
Lead/Quote (optional) → Sales/Ops confirms → Booked. Quote expiration and won/lost outcome tracked. Customer rate agreements (lane-based) can inform quote pricing (no automated rate engine in V1).

### 6.2 Carrier Sourcing & Dispatch
Manual sourcing → carrier assignment → Rate Confirmation generated and sent → Dispatch captures driver/equipment → load moves through Pickup/In Transit/Delivered with manual tracking updates (check calls, location, ETA, risk flag).

### 6.3 Document Lifecycle
Documents (Rate Confirmation, BOL, POD, receipts, photos, carrier compliance docs) attach to their parent entity, support versioning, appear in a chronological timeline on the parent record, and are also searchable/filterable from a standalone **Document Center**. Compliance documents carry an independent review state.

### 6.4 Billing & Settlement
POD received (soft gate) → Accounting manually builds/approves Customer Invoice (individual or consolidated across multiple loads for one customer, never double-billed) → Payments recorded (partial supported) → Credit/debit adjustments supported without destroying invoice history. In parallel, Carrier Pay is recorded (possibly multiple payments per load) through an approval workflow, with a generated settlement summary document.

### 6.5 Profitability
Every load computes: `Gross Profit = Total Customer Charges − Total Carrier Charges`, `Margin % = Gross Profit / Total Customer Charges × 100`. Rollups by customer, carrier, lane, dispatcher, sales user, date range, equipment type. Visible only to authorized roles.

### 6.6 Dispatch Operations
Each load has an assigned dispatcher (distinct from the Sales/Booking creator); reassignment is logged. Dispatchers work from a **Dispatch Board** with three views — Table/List, Kanban (by status, drag-and-drop where permitted), and Calendar (by appointment date). Upcoming-appointment visibility (next 4 hours, today, overdue) is a first-class operational need. Communication activity (calls, voicemails, declines, quotes) and internal notes are logged against the load, distinct from system-generated audit events. Bulk actions (assign dispatcher, update status, tag, export, etc.) are supported for non-financially-sensitive operations, all audited.

### 6.7 Tracking
Structured Check Calls (location, ETA, on-time/at-risk, notes) build a chronological tracking timeline per load. A separate **Risk Status** (Normal/At Risk/Delayed + reason) sits alongside the primary Status without replacing it. Configurable check-call cadence reminders alert the assigned dispatcher if an in-transit load goes quiet. All tracking is internal-only in V1 (no customer-facing tracking).

### 6.8 Reporting
Role-aware dashboards (Dispatcher, Sales, Accounting, Management/Admin) surface top KPIs on login. Standard report library covers Operations, Financial, Carrier Performance, Sales, and AR/AP categories, all with flexible date ranges (including period-over-period comparison), drill-down from KPI → report → record → transaction detail, and saved/reusable filtered views. A general-purpose Load Search with CSV/Excel export covers ad-hoc questions outside the fixed report set.

### 6.9 Bulk Onboarding / Migration
CSV/Excel bulk import (upload → map columns → validate → preview → confirm → import → summary report) supports onboarding Customers, Customer Contacts/Locations, Carriers, Carrier Contacts, Drivers, Trucks, and Trailers — critical for initial migration off whatever system/spreadsheets are used today.

---

## 7. Permission Model

- **Scoping:** every record belongs to one Organization; users only ever see their own Organization's data.
- **Role-based** in V1 (Admin, Operations Manager, Dispatcher, Sales/Booking, Accounting), with the data model able to grow toward granular custom permission sets later.
- **Financial visibility is the primary cut line:** customer revenue, carrier cost, gross profit, margin, invoices, payments, AR/AP are hidden from Dispatchers by default and gated to Admin, Management, Accounting, Sales (their own deals), and explicitly authorized Operations users.
- **Enforcement applies uniformly** across dashboards, reports, load detail views, exports, and (per the AI guardrails) any future AI copilot — no surface may leak data a role couldn't otherwise see.
- **Document visibility** follows the same two-factor rule: user's permissions AND access to the parent entity; document-type-specific permission (financial vs. compliance vs. operational vs. customer docs) is a future refinement.
- **Bulk and financially sensitive actions** (rate changes, invoice approval, carrier pay approval, closing a load) require explicit permission and are always audited — never casually available via bulk edit.
- **External roles (Customer, Carrier, Driver)** are architecturally reserved but carry zero access until their respective portal phases ship.

---

## 8. Financial Model

- **Line-item based**, not single-total: every customer charge and carrier cost is its own line item (type, description, quantity, unit rate, amount, source, notes), on both revenue and cost sides independently.
- **Charge types** (customer + carrier, symmetric): Linehaul, Fuel Surcharge, Detention, Lumper, Layover, TONU, Additional Stop, Re-delivery, Other Accessorial — predefined with org-level custom additions, future-extensible to GL categories.
- **No tax engine in V1**; taxes are explicitly out of scope but not architecturally blocked.
- **Invoicing:** individual (one load) or consolidated (multiple loads, one customer) invoices; a load can never be billed twice (billing status tracked per load); sequential org-scoped invoice numbers (`INV-000001`).
- **Invoice statuses:** Draft, Sent, Partially Paid, Paid, Overdue (auto-derived from terms + due date), Void, Credited.
- **Payments:** multiple partial payments per invoice; system computes remaining balance and derives paid status automatically.
- **Adjustments:** credit/debit memos against already-sent invoices, preserving original invoice history rather than relying on void-and-reissue.
- **Carrier Pay:** multiple payments per load (deposit/partial/balance/adjustment); remaining carrier balance computed automatically; approval workflow (Draft → Pending Approval → Approved → Paid) with approver, date, amount, notes recorded; a generated per-payment settlement summary document.
- **Profitability:** `Gross Profit = Revenue − Carrier Cost`; `Margin % = Gross Profit / Revenue`; computed at load level and aggregable across customer, carrier, lane, dispatcher, sales user, date range, equipment type; underlying line items preserved so figures can always be recalculated/audited.
- **AR / AP Aging:** both sides supported with standard buckets — Current, 1–30, 31–60, 61–90, 90+ days.
- **Financial integrity principle:** nothing is silently overwritten. Adjustments, credit memos, additional line items, payment records, and approval history are the only means of changing a financial outcome; every financially significant action is auditable.
- **No external accounting sync in V1** — the TMS is fully self-contained for AR/AP/payments/adjustments; QuickBooks (or similar) sync is the top-priority post-V1 integration.

---

## 9. Reporting Model

- **Dashboards are role-aware**, not one-size-fits-all: distinct default views/KPIs for Dispatcher, Sales, Accounting, and Management/Admin, each permission-filtered.
- **Standard report library** spans Operations (volume, status mix, on-time performance, dispatcher workload/productivity), Financial (revenue/cost/margin by customer, carrier, lane, and over time), Carrier Performance (load count, rejection rate, on-time %, cost history), Sales (quotes created/won/lost, win rate, revenue/GP by rep), and AR/AP (aging, outstanding, payment history).
- **Load Search** is a mandatory general-purpose, filterable, exportable (CSV/Excel) escape hatch for questions the fixed reports don't answer.
- **Date ranges** are flexible (standard presets + custom) with period-over-period comparison support.
- **Saved views** let users persist a filtered configuration for reuse; this is not a full custom report builder.
- **Drill-down is required**: KPI → report → record → transaction detail, without losing context.
- **Scheduled/emailed reports are deferred**, sharing future infrastructure with email notifications.
- **Reports are generated from live transactional data**, not duplicated reporting tables, wherever practical — preserving a path to future BI/AI/forecasting work without a parallel data pipeline.

---

## 10. Integration Architecture

### 10.1 V1 Integrations (Built Now)
- **Transactional outbound email** — send Rate Confirmations and Invoices directly from the system (recipient/CC/subject/message/attachment), with send activity logged against the related load/invoice. Not a full email client; no inbound handling.
- **Bulk CSV/Excel import** — Customers, Customer Contacts/Locations, Carriers, Carrier Contacts, Drivers, Trucks, Trailers, with a full map/validate/preview/confirm/summary workflow.
- **CSV/Excel export** — from Load Search and reports.

### 10.2 Deferred, Architecture-Ready Integrations
| Integration | Priority | Purpose |
|---|---|---|
| Accounting system (QuickBooks, etc.) | **1** | Sync customers, invoices, payments, vendors/carriers, carrier payments, credit memos; reconciliation |
| GPS/ELD tracking (Samsara, Motive, Project44, MacroPoint, etc.) | **2** | Automated location, ETA, tracking events, future customer visibility |
| Load boards (DAT, Truckstop, etc.) | **3** | Post loads, receive carrier responses/bids |
| EDI (204/210/214/990) | Later | Load tenders, status updates, invoicing with EDI-capable partners |
| Public API | Later | Authenticated, versioned, rate-limited external access to loads, customers, carriers, tracking, documents, invoices, payments |
| Outbound webhooks | Later | Event-driven notification to external systems (load booked, dispatched, delivered, invoice paid, etc.) |
| Customer / Carrier portals | Later | Self-service access built on already-reserved data relationships |
| Inbound email processing | Later / AI-era | Parse carrier replies, extract data, auto-log to load |
| Google Sheets | Later | Import/export/sync convenience layer once CSV workflows are proven |

### 10.3 Architectural Principle
All external integrations — present and future — must go through internal application/business-logic services (Loads, Customers, Carriers, Tracking, Documents, Billing, Payments, Notifications), never direct database manipulation. This is what makes the Priority 1–3 integrations and the eventual public API additive rather than a rewrite.

---

## 11. Future AI Roadmap

**AI is fully out of scope for V1.** The system must first produce clean, structured, auditable operational data; AI is layered on afterward.

| Priority | Capability | Summary |
|---|---|---|
| 1 | **Document Extraction (OCR/AI)** | Extract structured data from BOL, POD, Rate Confirmation, Invoice, W9, COI, etc. Produces a *proposed* record; human must review/approve before it becomes authoritative. |
| 2 | **Rate Intelligence** | Suggests customer quote ranges / carrier target rates / expected margin from historical rate, lane, and profitability data, with stated reasoning. Never auto-changes a rate — human approves. |
| 3 | **Carrier Selection** | Recommends carriers by lane history, cost, on-time performance, rejection rate, equipment fit, compliance/insurance eligibility, with stated reasoning. Never auto-assigns — human confirms. |
| 4 | **AI Copilot** | Conversational assistant ("what's my margin with ABC this month," "show at-risk loads," "draft a carrier ETA request email"). Strictly inherits the querying user's permissions — cannot surface data the user couldn't otherwise see. |
| 5 | **Exception / Risk Detection** | Proactively flags loads at elevated risk (late pickup/delivery, likely carrier rejection, abnormal margin) with explanation. Never auto-changes operational status. |
| 6 | **Forecasting & Advanced Analytics** | Volume, revenue, margin, capacity, and lane-rate forecasting. Lowest priority. |

### 11.1 Standing AI Guardrail (permanent principle)
AI may **suggest, analyze, draft, and recommend** — it may never unilaterally: change customer or carrier rates, assign a carrier, approve carrier payments, send binding financial documents, change invoice amounts, approve invoices, close a load, change compliance status, override permissions, or take any other irreversible operational action. A human must approve; the approval is logged in the audit trail alongside the AI's original recommendation (capability, input/context, recommendation, confidence where applicable, reviewing user, decision, final action, timestamp).

### 11.2 AI Architecture Principle
Future AI capabilities interact with the system through the same internal application services, authentication, authorization, business rules, validation, and audit logging as a human user — never direct database access, and never a parallel privilege path.

---

## 12. Technical Architecture Recommendations (Preliminary — Finalized in Stage 3/6)

These are directional recommendations to inform the upcoming **System Architecture** and **Technical Architecture** stages — not final decisions.

- **Multi-tenancy strategy**: shared database with an `organization_id` on every tenant-scoped table (row-level isolation) is the simplest starting point at this scale (100–500 loads/day across many orgs); revisit only if a specific tenant's scale/compliance needs demand physical isolation later.
- **Application structure**: organize around internal service boundaries per core domain (Loads, Customers, Carriers, Tracking, Documents, Billing, Payments, Notifications) from the start, even as a modular monolith — this is what makes the Priority 1–3 integrations, public API, webhooks, and AI roadmap additive later rather than a rewrite.
- **Document storage**: object storage (e.g., S3-compatible) with metadata/versioning tracked in the database; keep the document model polymorphic/reusable across entity types rather than per-entity tables.
- **Audit logging**: a single generalized audit log table/service (entity type, entity id, user, org, timestamp, action, previous/new value, reason) used uniformly by every domain, rather than bespoke history tables per entity.
- **Numbering (loads, invoices)**: org-scoped sequence generation, decoupled from the primary key, safe under concurrent creation.
- **Notifications**: build the in-app notification system on an internal event model now, so email (deferred) and webhooks (future) can subscribe to the same events later without redesign.
- **Background processing**: anticipate a job queue for things already implied by V1 (email sending, import processing, document generation) since these are natural first uses of async infrastructure that later integrations (GPS ingestion, EDI, webhooks) will also need.
- **Reporting**: query the transactional schema directly for V1 given the target scale; do not build a separate data warehouse/ETL pipeline until reporting load or the future AI/forecasting roadmap actually requires it.

*Full stack, hosting, and infrastructure decisions are deferred to the Technical Architecture stage.*

---

## 13. Recommended V1 Development Phases

A suggested build order — to be revisited once System Architecture and Database Design are complete:

1. **Foundation** — Organization/User model, auth, roles/permissions skeleton, audit log service.
2. **Core Entities** — Customer (+ contacts/locations), Carrier (+ contacts/compliance/insurance/equipment), Driver/Truck/Trailer (lightweight).
3. **Load Lifecycle Core** — Load + Stops + reference numbers, status flow (Quote → Booked → ... → Closed), status history.
4. **Dispatch** — carrier sourcing/assignment, dispatch record (driver/truck/trailer snapshot), Dispatch Board (table/kanban/calendar), assigned dispatcher + reassignment, communication log, internal notes.
5. **Documents** — polymorphic document system, versioning, Rate Confirmation generation, Document Center.
6. **Tracking** — check calls, current location, ETA, at-risk/delayed status, check-call reminders.
7. **Finance I** — charge line items, customer rate agreements, carrier rate history, invoicing (individual + consolidated), payments, credit/debit adjustments.
8. **Finance II** — carrier pay + approval workflow, settlement documents, profitability calculation, AR/AP aging.
9. **Reporting & Dashboards** — role-based dashboards, standard report library, Load Search/export, saved views, drill-down.
10. **Notifications** — in-app notification system across all the alert types already identified.
11. **Bulk Import** — CSV/Excel onboarding workflow for Customers/Carriers/Drivers/Trucks/Trailers.
12. **Transactional Email** — send Rate Confirmation / Invoice from the system, with activity logging.
13. **Hardening** — permission enforcement pass across all surfaces, audit trail completeness review, multi-tenant isolation testing.

---

## 14. Database / Entity Relationship Overview (High-Level — Not Final Schema)

This is a conceptual relationship map to guide the upcoming **Database Design** stage — not a schema.

```
Organization
 ├── User (role: Admin/Ops Mgr/Dispatcher/Sales/Accounting)
 ├── Customer
 │    ├── Customer Contact (many)
 │    ├── Customer Location (many)
 │    ├── Customer Rate Agreement (many)
 │    └── [future] Customer User
 ├── Carrier
 │    ├── Carrier Contact (many)
 │    ├── Carrier Compliance Document (many)
 │    ├── Carrier Insurance (many)
 │    ├── Carrier FMCSA Verification
 │    ├── Carrier Factoring Info
 │    ├── Driver (many)
 │    ├── Truck (many)
 │    ├── Trailer (many)
 │    └── [future] Carrier User
 ├── Load
 │    ├── Stop (many, sequenced)
 │    ├── Dispatch Record (assigned Carrier, Driver snapshot, Truck snapshot, Trailer snapshot)
 │    ├── Charge Line Item (many; customer-side and carrier-side)
 │    ├── Check Call (many)
 │    ├── Tracking/Location Snapshot (many)
 │    ├── Risk Status
 │    ├── Activity/Communication Log Entry (many)
 │    ├── Internal Note (many)
 │    ├── Status History (many)
 │    ├── External Posting Record
 │    └── Document (many, via polymorphic association)
 ├── Quote (precedes Load, or converts to Load)
 ├── Invoice (references one or many Loads)
 │    ├── Payment (many)
 │    └── Credit/Debit Adjustment (many)
 ├── Carrier Payment (many per Load)
 │    └── Carrier Settlement Document
 ├── Document (polymorphic: Load | Customer | Carrier | Driver | Truck | Trailer | Invoice)
 ├── Notification (per User)
 ├── Saved Report View (per User)
 ├── Import Batch (per entity type)
 └── Audit Log Entry (universal, references any entity)
```

Key relationship principles carried forward from requirements:
- Every top-level entity hangs off **Organization** — no cross-tenant relationships.
- **Document** is a single reusable polymorphic model, not per-entity document tables.
- **Dispatch Record** snapshots driver/truck/trailer data at time of dispatch rather than only referencing the live Carrier-linked record, so historical loads remain accurate.
- **Invoice ↔ Load** is many-to-many in effect (consolidated billing) but each Load tracks its own billed status to prevent double-billing.
- **Rate values are never mutated in place** — original Charge Line Items persist; changes are additional line items/adjustments.
- **Audit Log Entry** is a universal, generic association (entity type + entity id) rather than one audit table per entity.

---

## 15. Remaining Critical Ambiguities to Resolve Before Coding

These were not fully specified in the requirements conversation and should be resolved in the **Business Workflows** or **Database Design** stage before implementation begins:

1. **Organization onboarding/setup** — how is a new Organization (tenant) created? Self-service signup, invite-only, admin-provisioned? Is there a "super admin"/platform-operator role above Organization Admin for supporting multiple tenants?
2. **Payment terms defaulting** — exact rule for computing an invoice due date from payment terms (e.g., from invoice date vs. delivery date) needs to be pinned down precisely.
3. **Quote-to-Load conversion mechanics** — does converting a QUOTE to BOOKED create a new Load record, or does the Quote *become* the Load (same record, status change)? This affects the data model directly.
4. **Multi-stop rate/accessorial attribution** — when a load has multiple stops, how are stop-specific accessorials (e.g., detention at Stop 2 only) attributed and displayed relative to load-level totals?
5. **Consolidated invoice line-item detail** — does a consolidated invoice show one line per load, one line per charge-per-load, or a customizable level of detail?
6. **Carrier pay approval authority** — who is authorized to approve carrier pay (specific role, dollar-amount thresholds, or configurable per organization)?
7. **"Clean close" checklist enforcement scope** — is the readiness checklist identical for every organization, or configurable per organization (e.g., some may not require a Rate Confirmation on file)?
8. **Check-call reminder cadence configuration** — organization-wide default only, or configurable per lane/customer/load priority?
9. **Document required-type enforcement** — should certain document types become mandatory before certain status transitions (e.g., can't move to DISPATCHED without a signed Carrier Agreement on file for a first-time carrier), or is this purely advisory in V1?
10. **User invitation & deactivation flow** — not yet discussed: how internal users are invited, deactivated, and whether seats are limited/billed per organization (relevant to the SaaS business model itself, not just the TMS domain).
11. **Custom document/charge type governance** — who within an organization is allowed to create org-level custom document types and accessorial charge types (Admin only, or configurable)?
12. **Numbering format configurability** — is the load number / invoice number prefix and format (e.g., `INV-000001`) fixed platform-wide or configurable per organization?

---

*This PRD reflects all decisions made through the requirements-gathering conversation. It is the input to Stage 2 (Business Workflows), not a final specification — items in Section 15 should be resolved before database schema or application code is written.*
