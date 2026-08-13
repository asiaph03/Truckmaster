# Workflow 5: Carrier Sourcing, Assignment & Rate Confirmation
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md)

## Actors
| Actor | Description |
|---|---|
| **Sourcing User** | Admin, Operations Manager, or Dispatcher — sources and assigns carriers (Sales/Booking does not perform this step in V1) |
| **System** | The TMS application (eligibility enforcement, rate history lookup, document generation, audit logging) |

## Trigger
A `BOOKED` Load needs a carrier. A Sourcing User begins working the load.

## Preconditions
- Load status = `BOOKED` (or the load has cycled back from a prior rejection — see 5.6).
- Acting user is Active and holds Admin, Operations Manager, or Dispatcher role.

---

## 5.1 Entering Carrier Sourcing

| Step | Sourcing User | System |
|---|---|---|
| 1 | Opens a `BOOKED` load and selects "Begin Carrier Sourcing" | — |
| 2 | — | Transitions Load status: `BOOKED` → `CARRIER_SOURCING` |
| 3 | — | Writes audit event: `Load Entered Carrier Sourcing` |

**Status Transitions:** Load: `BOOKED` → `CARRIER_SOURCING`
**Note:** This is an explicit user-initiated transition — the load does not enter this status automatically just because it's Booked and unassigned.

**Completion Criteria:** Load status = `CARRIER_SOURCING`, ready for carrier evaluation and logging.

---

## 5.2 Carrier Rate History Reference (informational sub-process)

| Step | Sourcing User | System |
|---|---|---|
| 1 | Views the load's lane (origin/destination) and equipment type while sourcing | — |
| 2 | — | Displays historical Carrier Rate History for that lane/equipment (rates previously paid, by carrier, if available) as reference information |
| 3 | Uses this information to negotiate, but manually enters the final agreed rate | — |

**Note:** This is reference-only. The system never auto-populates the carrier rate field from history — negotiation and entry remain fully manual in V1.

**Completion Criteria:** N/A (informational; no state change) — supports the Carrier Selection step (5.3) but doesn't gate it.

---

## 5.3 Carrier Selection & Assignment Eligibility Validation (hard gate)

**Trigger:** Sourcing User selects a candidate carrier to assign to the load

| Step | Sourcing User | System |
|---|---|---|
| 1 | Searches/selects a Carrier | System retrieves `Carrier.assignment_eligible` and, if `NO`, the ineligibility reason(s) |
| 2a | — (eligible) | Allows selection to proceed |
| 2b | — (ineligible) | **Blocks assignment entirely** — no override available; displays the specific reason(s) (e.g., "COI expired," "Not yet Active") |
| 3 | If blocked, selects a different carrier or pauses sourcing | — |

**System Validations:** `Carrier.assignment_eligible = YES` is a mandatory, non-overridable condition for assignment. This check re-runs live at the moment of assignment (not just relying on a stale eligibility flag), since eligibility can change between when a carrier was first considered and when the user clicks "Assign."

**Audit Events:** `Carrier Assignment Blocked — Ineligible` (system-generated, only on a blocked attempt, records carrier + reason(s))

**Completion Criteria:** Only an eligible carrier can proceed to 5.4.

---

## 5.4 Carrier Assignment

**Preconditions:** Selected Carrier has `assignment_eligible = YES` (validated in 5.3)

| Step | Sourcing User | System |
|---|---|---|
| 1 | Confirms selected Carrier | — |
| 2 | Enters the negotiated carrier rate | — |
| 3 | Submits assignment | Re-validates eligibility (5.3) at the moment of submission |
| 4 | — | Creates a **Carrier Sourcing Attempt** record: carrier, carrier_rate, assigned_by, assigned_at, outcome = `ASSIGNED` (pending) |
| 5 | — | Transitions Load status: `CARRIER_SOURCING` → `CARRIER_ASSIGNED`; sets `Load.assigned_carrier_id`, `Load.carrier_rate` |
| 6 | — | Writes audit event: `Carrier Assigned` |

**Required Fields:** Carrier (eligible), carrier rate.

**Status Transitions:** Load: `CARRIER_SOURCING` → `CARRIER_ASSIGNED`
**Data Created:** `Carrier Sourcing Attempt` record (see 5.5 for full model); `Load.assigned_carrier_id`, `Load.carrier_rate`, `Load.rate_source` (manual, per 5.2)
**Audit Events:** `Carrier Assigned` (actor: Sourcing User, records carrier + rate)

**Completion Criteria:** Load status = `CARRIER_ASSIGNED`, with a carrier and carrier rate on record.

---

## 5.5 Sourcing Attempt Logging (optional, cumulative history)

**Trigger:** Sourcing User optionally logs contact with any carrier — whether it results in assignment, decline, or no response — at any point during sourcing.

| Step | Sourcing User | System |
|---|---|---|
| 1 | Selects "Log Sourcing Contact," enters carrier, rate quoted (if any), outcome (Declined / No Response / Quoted / Other), notes | — |
| 2 | Submits | Creates a new **Carrier Sourcing Attempt** record — always a **new record**, never overwriting a prior attempt |
| 3 | — | Writes audit event: `Sourcing Attempt Logged`; the entry also appears in the Load's Communication Activity log (per Workflow 3's dispatch-communication pattern) |

**Data Model — Carrier Sourcing Attempt (applies to both this step and 5.4/5.6):**
`load_id, carrier_id, carrier_rate (nullable), outcome (ASSIGNED | DECLINED | NO_RESPONSE | QUOTED | REJECTED_AFTER_ASSIGNMENT), rejection_reason (nullable), logged_by, logged_at`

**Rule:** Logging is optional except for the record created automatically at the moment of actual assignment (5.4) — that one is mandatory since it's a direct byproduct of the Assign action, not a separate manual log entry. Every attempt, whether system-generated (from assignment/rejection) or manually logged, is preserved as its own row — never updated in place.

**Completion Criteria:** N/A as a gate — this is an ongoing, optional activity throughout sourcing. Its value is a complete, permanent sourcing history per load.

---

## 5.6 Carrier Rejection Handling

**Trigger:** The assigned Carrier backs out after being assigned (`CARRIER_ASSIGNED` or later, before Dispatch is complete)

| Step | Sourcing User | System |
|---|---|---|
| 1 | Selects "Carrier Rejected" on the assigned carrier, enters rejection reason (required) | — |
| 2 | Submits | Updates the existing `Carrier Sourcing Attempt` record for this assignment: outcome → `REJECTED_AFTER_ASSIGNMENT`, rejection_reason, rejected_at — **retained in full**, not deleted |
| 3 | — | Clears `Load.assigned_carrier_id` and `Load.carrier_rate` (load itself no longer shows an active assignment) |
| 4 | — | Transitions Load status: `CARRIER_ASSIGNED` → `CARRIER_SOURCING` |
| 5 | — | Writes audit event: `Carrier Rejected — Returned to Sourcing` |

**Data Retained (never discarded):** carrier, carrier rate that had been agreed, rejection reason, timestamp, user — as a permanent `Carrier Sourcing Attempt` record, distinct from and in addition to any new attempts that follow.

**Status Transitions:** Load: `CARRIER_ASSIGNED` → `CARRIER_SOURCING`
**Cycle Limit:** None — a load may cycle through 5.3 → 5.4 → 5.6 as many times as needed; each cycle produces its own permanent `Carrier Sourcing Attempt` record. No automatic escalation in V1.
**Audit Events:** `Carrier Rejected — Returned to Sourcing` (actor: Sourcing User, records carrier, rate, reason)

**Completion Criteria:** Load returns to `CARRIER_SOURCING` with no active carrier assignment; the rejected attempt is permanently preserved in sourcing history.

---

## 5.7 Rate Confirmation Generation (hard gate before Dispatch)

**Trigger:** Sourcing User initiates "Generate Rate Confirmation" on a `CARRIER_ASSIGNED` load
**Preconditions:** Load status = `CARRIER_ASSIGNED`; Carrier and carrier rate are on record

| Step | Sourcing User | System |
|---|---|---|
| 1 | Selects "Generate Rate Confirmation" | Validates Carrier + carrier rate are present (driver/truck/trailer NOT required at this step) |
| 2 | — | Generates Rate Confirmation PDF from Load + Carrier + rate data |
| 3 | — | Creates `Document` record: type = Rate Confirmation, version = 1, associated with Load |
| 4 | Reviews generated document | — |
| 5 | *(Optional, per Workflow prior decisions)* Sends via email to carrier (per transactional email capability) | Logs send activity if emailed |
| 6 | — | Transitions Load status: `CARRIER_ASSIGNED` → `RATE_CONFIRMATION` |
| 7 | — | Writes audit event: `Rate Confirmation Generated` |

**Required for Generation:** Carrier assigned, carrier rate recorded. Driver/truck/trailer are **not** required at this point — those are captured later during Dispatch (Workflow 6).

**Status Transitions:** Load: `CARRIER_ASSIGNED` → `RATE_CONFIRMATION`
**Documents Generated:** Rate Confirmation (PDF), version 1
**Audit Events:** `Rate Confirmation Generated` (actor: Sourcing User); `Rate Confirmation Sent` (if emailed, per existing transactional email workflow)

**Completion Criteria:** A Rate Confirmation document exists on file for the load, and Load status = `RATE_CONFIRMATION`.

**Hard Gate:** A load **cannot** move to `DISPATCHED` (Workflow 6) without a Rate Confirmation on file. This is enforced at the Dispatch transition, not here — noted as the boundary condition into the next workflow (5.9).

---

## 5.8 Dispatcher Assignment (cross-reference, independent of this workflow)

Dispatcher assignment (`Load.dispatcher_id`) remains a fully separate, manual action that may occur before, during, or after any step in this workflow. Beginning carrier sourcing does **not** automatically assign the sourcing user as dispatcher. This workflow neither sets nor depends on `dispatcher_id` — it is referenced here only to confirm no implicit assignment occurs.

---

## 5.9 Handoff to Workflow 6 (Dispatch)

Workflow 5 ends when a Load reaches status `RATE_CONFIRMATION` with a Rate Confirmation document on file. Workflow 6 (`DISPATCHED → PICKUP → IN TRANSIT → DELIVERED`) begins from there and is responsible for satisfying the remaining conditions before `DISPATCHED` is reachable:

**Full gate to `DISPATCHED` (for reference — enforced in Workflow 6, listed here for continuity):**
- Eligible carrier assigned ✅ (satisfied by end of this workflow)
- Carrier rate recorded ✅ (satisfied by end of this workflow)
- Rate Confirmation generated and on file ✅ (satisfied by end of this workflow)
- Driver name recorded — *(Workflow 6)*
- Driver phone recorded — *(Workflow 6)*
- Truck number recorded — *(Workflow 6)*
- Trailer number recorded — *(Workflow 6)*

---

## Cross-Cutting: Permissions
- Carrier sourcing, assignment, rejection handling, and Rate Confirmation generation: Admin, Operations Manager, Dispatcher.
- Sales/Booking has no action permissions in this workflow (view-only, per existing permission model).

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Load Entered Carrier Sourcing` | Sourcing User |
| `Carrier Assignment Blocked — Ineligible` | System (automatic) |
| `Carrier Assigned` | Sourcing User |
| `Sourcing Attempt Logged` | Sourcing User (optional, ongoing) |
| `Carrier Rejected — Returned to Sourcing` | Sourcing User |
| `Rate Confirmation Generated` | Sourcing User |
| `Rate Confirmation Sent` | Sourcing User (if emailed) |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Selected carrier is assignment-ineligible | Hard block, no override, reason(s) shown |
| Carrier eligibility changes between selection and submission | Re-validated at submission; blocked if no longer eligible |
| Assigned carrier rejects the load | Full sourcing attempt preserved (carrier, rate, reason, timestamp, user); load returns to `CARRIER_SOURCING`; no cycle limit |
| Attempt to generate Rate Confirmation without carrier/rate | Blocked, required fields listed |
| Attempt to move to `DISPATCHED` without Rate Confirmation on file | Blocked (enforced in Workflow 6, gate defined here) |

---

*Locked as part of Stage 2 — Business Workflows. Defines the explicit transition into Carrier Sourcing, reference-only rate history, the non-overridable Assignment Eligibility hard gate, carrier assignment, optional-but-permanent sourcing attempt logging, full-history-preserving carrier rejection handling with no cycle limit, and Rate Confirmation generation as a hard gate before Dispatch. Driver/truck/trailer capture and the full Dispatch gate belong to Workflow 6.*
