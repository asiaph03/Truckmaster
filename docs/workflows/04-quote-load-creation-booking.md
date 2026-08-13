# Workflow 4: Quote / Load Creation & Booking
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md)

## Actors
| Actor | Description |
|---|---|
| **Creating User** | Admin, Sales/Booking, Operations Manager, or Dispatcher — creates Quotes and/or Loads |
| **System** | The TMS application (validation, numbering, rate-agreement matching, audit logging) |

## Trigger
A customer requests freight movement (call, email, repeat business, etc.), and an authorized user begins either a Quote or a direct Booking in the system.

## Preconditions
- Acting user is Active and holds Admin, Sales/Booking, Operations Manager, or Dispatcher role.
- Customer record exists (created per Workflow 2).

---

## 4.1 Entry Path Selection

| Step | Creating User | System |
|---|---|---|
| 1 | Chooses "New Quote" or "New Load (Direct Booking)" | — |
| 2 | — | Routes to the appropriate creation flow (4.2 Quote path, or 4.8 Direct-to-Booked path) |

**Note:** The path is a free choice by the user for every transaction — the system does not force Quote-first based on role, customer history, or any other rule.

---

## 4.2 Quote Creation

**Preconditions:** Customer status is `PROSPECT`, `ACTIVE`, or `INACTIVE` (with warning) — not `BLOCKED` (see 4.3 for the status gate).

| Step | Creating User | System |
|---|---|---|
| 1 | Selects Customer | Runs Customer Status Validation (4.3) |
| 2 | Enters at least one pickup stop and one delivery stop (location, address, appointment info) | — |
| 3 | Selects equipment type | — |
| 4 | Enters/confirms customer rate | System checks for a matching active Customer Rate Agreement (4.4) and pre-fills/suggests if found |
| 5 | *(Optional)* Adjusts default 7-day expiration date | — |
| 6 | Submits | Validates all required fields present |
| 7 | — | Generates Quote number (`QUOTE-000123`, own sequence — see 4.9) |
| 8 | — | Creates `Quote` record: status = `OPEN`, customer_rate, rate_source, rate_agreement_id (if applicable), expiration_date, created_by, created_at |
| 9 | — | Writes audit event: `Quote Created` |

**Required Fields:** Customer, ≥1 pickup stop, ≥1 delivery stop, equipment type, customer rate.
**Explicitly not required:** carrier assignment, dispatch info, POD, BOL, or any downstream load information.

**Status Assignment (Quote):** `OPEN` at creation, expiring at `expiration_date` (default now + 7 days).

**Data Created:** `Quote` record: organization_id, quote_number, customer_id, stops[], equipment_type, customer_rate, rate_source, rate_agreement_id (nullable), status = Open, expiration_date, created_by, created_at.

**Documents Generated:** None
**Notifications:** None specified for creation itself
**Audit Events:** `Quote Created` (actor: Creating User)

**Completion Criteria:** `Quote` record exists with status `OPEN`, a valid expiration date, and all required fields populated.

---

## 4.3 Customer Status Validation (sub-process — runs on both Quote and Direct-to-Booked paths)

| Customer Status | Quote Creation | Load → BOOKED |
|---|---|---|
| `PROSPECT` | ✅ Allowed | ❌ Blocked — Customer must be `ACTIVE` first |
| `ACTIVE` | ✅ Allowed | ✅ Allowed |
| `INACTIVE` | ⚠️ Allowed with warning | ⚠️ Requires authorized user confirmation/override |
| `BLOCKED` | ❌ Blocked | ❌ Blocked |

| Step | Creating User | System |
|---|---|---|
| 1 | Selects Customer for a Quote or Load | System checks Customer.status |
| 2a | — (Prospect/Active) | Proceeds normally |
| 2b | — (Inactive, Quote path) | Displays warning banner ("This customer is Inactive"); allows continuation without further action |
| 2c | — (Inactive, Booking path) | Blocks the BOOKED transition until user explicitly confirms/overrides; writes audit event `Inactive Customer Booking Override` on confirmation |
| 2d | — (Blocked) | Blocks the action entirely with explanation; no override available |

**Audit Events:** `Inactive Customer Booking Override` (actor: confirming user, only when applicable); status checks that pass silently are not separately audited (the resulting Quote/Load creation event is sufficient).

**Completion Criteria:** Customer status permits the requested action, or the action is blocked/requires override per the table above.

---

## 4.4 Rate Agreement Matching

**Trigger:** User is entering/reviewing a customer rate on a Quote or Direct-to-Booked Load, having selected Customer + lane (origin/destination) + equipment type.

| Step | Creating User | System |
|---|---|---|
| 1 | Selects/confirms origin, destination, equipment type | Searches Customer's active Rate Agreements for a match on lane + equipment |
| 2a | — (match found) | Pre-fills the customer rate field with the agreement rate; flags the field as "From Rate Agreement [ID]"; records `rate_agreement_id` |
| 2b | — (no match found) | Leaves rate field blank/manual entry; no suggestion shown; `rate_agreement_id` = NULL |
| 3a | Accepts pre-filled rate as-is | `rate_source` = `RATE_AGREEMENT`; `rate_agreement_id` retained |
| 3b | Overrides the suggested rate manually | `rate_source` = `MANUAL_OVERRIDE`; **`rate_agreement_id` is still retained** (not cleared) so the original agreement reference remains linked for historical/reporting purposes |

**Data Captured (Quote and Load, independently):** `customer_rate` (final value used), `rate_agreement_id` (the matched agreement, if any — retained regardless of override), `rate_source` (`RATE_AGREEMENT` or `MANUAL_OVERRIDE`). The agreement's original suggested rate remains readable via the linked `rate_agreement_id` record, so the suggested rate, the agreement reference, and the final booked rate are all independently reconstructable later.

**Audit Events:** Rate source and agreement linkage are captured as part of the Quote/Load creation event; an override after initial fill is captured via the standard field-change audit (previous value = agreement rate, new value = overridden rate).

**Completion Criteria:** A customer rate is set, with its origin (agreement-derived or manual override) and, where applicable, the originating Rate Agreement ID always preserved — even when overridden.

---

## 4.5 Quote Expiration

**Trigger:** Scheduled system check identifies an `OPEN` Quote past its `expiration_date`.

| Step | Creating User | System |
|---|---|---|
| 1 | — | Scheduled process identifies `OPEN` Quotes where current date > expiration_date |
| 2 | — | Transitions Quote status: `OPEN` → `LOST`; sets loss_reason = "Expired" (system-generated reason) |
| 3 | — | Writes audit event: `Quote Expired — Automatically Marked Lost` |

**Status Transitions:** Quote: `OPEN` → `LOST` (automatic)
**Completion Criteria:** No `OPEN` Quote persists past its expiration date without being resolved to `LOST`.

---

## 4.6 Quote Won / Lost Handling

**Trigger:** Either (a) user explicitly marks a Quote Lost, or (b) Quote converts to a Booked Load (4.7), or (c) automatic expiration (4.5).

| Step | Creating User | System |
|---|---|---|
| 1a | Selects "Mark as Lost" on an `OPEN` Quote, enters required loss reason | Validates reason is non-empty; transitions Quote status `OPEN` → `LOST`; writes audit event `Quote Marked Lost` |
| 1b | Converts Quote to Booked Load (4.7) | Automatically transitions Quote status `OPEN` → `WON` as part of the conversion transaction; writes audit event `Quote Won — Converted to Load` |
| 1c | *(system-driven)* | Expiration sweep (4.5) transitions `OPEN` → `LOST` |

**System Validations**
- A Quote already `WON` cannot subsequently be marked `LOST` (action unavailable once Won).
- **`LOST` is permanently terminal.** A Lost Quote (whether by explicit action or automatic expiration) can never be reopened, edited back to `OPEN`, or converted to a Load. If the customer wants to revisit pricing after a Quote is Lost, the user must create a **new** Quote. This keeps quote history, conversion/win-rate metrics, and pricing history clean.

**Status Transitions:** Quote: `OPEN` → `WON` | `LOST` (both terminal; no transitions out of either state)
**Audit Events:** `Quote Marked Lost` (actor: user, with reason), `Quote Won — Converted to Load` (system, tied to conversion), `Quote Expired — Automatically Marked Lost` (system)

**Completion Criteria:** Every Quote eventually reaches a terminal state (`WON` or `LOST`); the terminal state and its cause are permanently recorded and never reversed.

---

## 4.7 Quote → Load Conversion (Booking)

**Trigger:** Creating User selects "Convert to Booked" on an `OPEN` Quote
**Preconditions:** Quote status = `OPEN`; Customer status = `ACTIVE` (or `INACTIVE` with override, per 4.3)

| Step | Creating User | System |
|---|---|---|
| 1 | Selects "Convert to Booked" on the Quote | Runs Customer Status Validation (4.3) against current Customer status |
| 2 | Reviews carried-forward details (stops, equipment, customer rate, rate_agreement_id) | Pre-fills a new Load form with all Quote data |
| 3 | **Explicitly confirms the customer rate** — either accepts the quoted rate as-is or modifies it | Validates a rate confirmation action has occurred (cannot proceed silently) |
| 4 | Submits | Generates Load Number (`LOAD-000456`, own sequence — see 4.9) |
| 5 | — | Creates new `Load` record: status = `BOOKED`, customer_rate = confirmed rate, `booking_source` = `QUOTE`, `quote_id` = reference to originating Quote, rate_agreement_id carried from Quote (if any), dispatcher_id = NULL |
| 6 | — | If rate was modified during conversion: preserves original `Quote.customer_rate` unchanged; records the (possibly different) `Load.customer_rate` separately, with a link back showing both values |
| 7 | — | Transitions Quote status `OPEN` → `WON` (per 4.6); sets `Quote.resulting_load_id` = new Load's ID |
| 8 | — | Writes audit events: `Load Booked From Quote`, `Quote Won — Converted to Load` |

**Relationship:** `Quote 1 → 0..1 Load`. Quote and Load are separate records with independent numbering sequences; the Quote is retained permanently as a historical record referencing its resulting Load.

**Data Created:** New `Load` record (see 4.9 for numbering, 4.11 for dispatcher handling), with `booking_source = QUOTE` and `quote_id` set.
**Data Preserved on Quote:** original quoted customer rate, rate_agreement_id, quote creation date, expiration date, final status (`WON`), creator, link to resulting Load.
**Data Preserved on Load:** final booked customer rate (which may differ from the original quoted rate), `booking_source = QUOTE`, `quote_id`, link back to originating Quote.

**Documents Generated:** None at this step (Rate Confirmation generation belongs to a later Dispatch-stage workflow)
**Audit Events:** `Load Booked From Quote`, `Quote Won — Converted to Load`, plus `Rate Changed During Conversion` (only if the confirmed rate differs from the original quoted rate — captures old value, new value, user)

**Exceptions**
- Customer became `BLOCKED` or dropped out of good standing between Quote creation and conversion → conversion blocked, same rules as 4.3.
- Quote already `WON` or `LOST` → "Convert to Booked" action unavailable; a `LOST` Quote can never be reopened (4.6) — user must create a new Quote or a Direct-to-Booked Load instead.

**Completion Criteria:** New `Load` record exists with status `BOOKED`, `booking_source = QUOTE`, a confirmed customer rate, a Load Number, and a permanent link to its originating Quote (now `WON`).

---

## 4.8 Direct-to-Booked Creation (no Quote)

**Preconditions:** Customer status = `ACTIVE` (or `INACTIVE` with override, per 4.3)

| Step | Creating User | System |
|---|---|---|
| 1 | Selects Customer | Runs Customer Status Validation (4.3) |
| 2 | Enters at least one pickup stop and one delivery stop | — |
| 3 | Selects equipment type | — |
| 4 | Enters/confirms customer rate | System checks for matching Rate Agreement (4.4) and pre-fills/suggests if found |
| 5 | *(Optional)* Enters reference numbers (PO #, BOL #, pickup #, customer reference #) | — |
| 6 | Submits as "Booked" | Validates all required fields present; re-confirms Customer status is still valid |
| 7 | — | Generates Load Number (`LOAD-000456`) |
| 8 | — | Creates `Load` record: status = `BOOKED`, customer_rate, rate_source, rate_agreement_id (if applicable), `booking_source` = `DIRECT`, `quote_id` = NULL, dispatcher_id = NULL |
| 9 | — | Writes audit event: `Load Booked Directly (No Quote)` |

**Required Fields:** Active Customer, ≥1 pickup stop, ≥1 delivery stop, equipment type, customer rate.
**Optional at booking (addable later, per 4.10):** Customer reference number, PO number, BOL number, pickup number.

**Data Created:** `Load` record: organization_id, load_number, customer_id, stops[], equipment_type, customer_rate, rate_source, rate_agreement_id (nullable), reference numbers (if provided), `booking_source = DIRECT`, `quote_id = NULL`, status = Booked, dispatcher_id = NULL, created_by, created_at.

**Completion Criteria:** `Load` record exists with status `BOOKED`, `booking_source = DIRECT`, a Load Number, and all required fields populated — with no originating Quote.

---

## 4.9 Load & Quote Numbering

| Entity | Numbering Trigger | Format Example |
|---|---|---|
| Quote | At Quote creation (4.2) | `QUOTE-000123` |
| Load | Only at the moment a transaction becomes `BOOKED` — either via Quote conversion (4.7) or Direct booking (4.8) | `LOAD-000456` |

**Rule:** A Quote never consumes a Load Number. The two sequences are independent and both org-scoped, sequential, and separate from the underlying database ID (consistent with the numbering pattern established for Customers/Invoices).

**Completion Criteria:** Every Quote has exactly one Quote Number at creation; every Load receives exactly one Load Number at the moment it becomes Booked, regardless of path.

---

## 4.10 Reference Numbers (Optional, Addable Later)

| Step | Creating User | System |
|---|---|---|
| 1 | *(At booking, or any time after)* Enters/updates Customer PO number, BOL number, pickup number, and/or customer reference number | — |
| 2 | Submits | Validates field formats (if any); saves values |
| 3 | — | Writes audit event: `Reference Number Added/Updated` (field, previous value, new value, user, timestamp) |

**Completion Criteria:** Reference numbers can be added or changed at any point in the Load's life, always captured in the audit trail — never required to reach `BOOKED`.

---

## 4.11 Dispatcher Assignment Handoff

Per the locked decision, dispatcher assignment is **not** part of this workflow. Upon reaching `BOOKED` (via either path), `Load.dispatcher_id = NULL`. Assignment of the responsible dispatcher is a separate action, defined by a future Dispatch workflow (which will reuse the `dispatcher_id` field and audit pattern already established in Workflow 1's "reassignment" concept).

**Completion Criteria (for this workflow's purposes):** A newly Booked Load is visible in an "Unassigned" queue/filter so dispatchers/managers can identify it needs a dispatcher — the assignment action itself is out of scope here.

---

## Cross-Cutting: Permissions

- Quote and Load creation (both paths) available to: Admin, Sales/Booking, Operations Manager, Dispatcher.
- Marking a Quote Lost, confirming a rate during conversion, and overriding an Inactive-customer booking all require the same creation permission — no additional distinct permission introduced in this workflow.

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Quote Created` | Creating User |
| `Inactive Customer Booking Override` | Confirming User |
| `Quote Expired — Automatically Marked Lost` | System (automatic) |
| `Quote Marked Lost` | Creating/authorized User (with reason) |
| `Quote Won — Converted to Load` | System (tied to conversion) |
| `Load Booked From Quote` | Creating User |
| `Rate Changed During Conversion` | Creating User (only if rate modified) |
| `Load Booked Directly (No Quote)` | Creating User |
| `Reference Number Added/Updated` | Any authorized user, any time |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Customer is `BLOCKED` | Quote and Load creation both blocked entirely, no override |
| Customer is `PROSPECT` | Quote allowed; Booking blocked until Customer becomes `ACTIVE` |
| Customer is `INACTIVE` | Quote allowed with warning; Booking requires explicit override, logged |
| Quote expires unconverted | Automatically marked `LOST`, reason = "Expired" — permanently terminal |
| Quote already `WON`/`LOST` | Cannot be converted or reopened; user starts a new Quote or Direct booking |
| Rate changed during conversion | Original Quote rate preserved; new Load rate recorded separately; change audited |
| No matching Rate Agreement | Manual rate entry proceeds normally, no blocking |
| Rate Agreement suggestion overridden | `rate_source = MANUAL_OVERRIDE`, but `rate_agreement_id` is retained, not cleared |

---

*Locked as part of Stage 2 — Business Workflows. Defines the two Quote/Load entry paths, Customer-status gating (Prospect/Active/Inactive/Blocked) across both Quote and Booking, Rate Agreement matching with persistent agreement linkage even on override, Quote expiration and permanently-terminal Won/Lost handling, Quote→Load conversion mechanics (separate records, `quote_id` reference, `booking_source` field), independent Quote/Load numbering sequences, optional-and-later-addable reference numbers, and the handoff of dispatcher assignment to a future Dispatch workflow.*
