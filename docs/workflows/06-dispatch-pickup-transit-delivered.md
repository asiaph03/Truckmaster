# Workflow 6: Dispatch → Pickup → In Transit → Delivered
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md), [Workflow 5](05-carrier-sourcing-assignment-rate-confirmation.md)

## Actors
| Actor | Description |
|---|---|
| **Dispatcher** | Admin, Operations Manager, or Dispatcher — performs dispatch and records stop progress based on driver check-ins |
| **System** | The TMS application (gate validation, snapshotting, status derivation, audit logging) |

## Trigger
A Load reaches status `RATE_CONFIRMATION` with a Rate Confirmation on file (end of Workflow 5), and the Dispatcher begins capturing driver/equipment information to dispatch it.

## Preconditions
- Load status = `RATE_CONFIRMATION`.
- Acting user is Active and holds Admin, Operations Manager, or Dispatcher role.

---

## 6.1 Dispatch Information Capture & Explicit Dispatch Action

| Step | Dispatcher | System |
|---|---|---|
| 1 | Selects driver from the assigned Carrier's reusable Driver records, or enters driver name/phone manually | — |
| 2 | Selects truck from the Carrier's reusable Truck records, or enters truck number manually | — |
| 3 | Selects trailer from the Carrier's reusable Trailer records, or enters trailer number manually | — |
| 4 | Reviews all four fields (driver name, driver phone, truck #, trailer #) | Validates all four are present |
| 5 | Clicks explicit **"Dispatch Load"** action | Re-validates full Workflow-5 gate: eligible carrier assigned, carrier rate recorded, Rate Confirmation on file, plus driver name/phone/truck/trailer all present |
| 6a | — (gate satisfied) | Snapshots driver/equipment values onto the Load's dispatch record (see 6.2); transitions Load status `RATE_CONFIRMATION` → `DISPATCHED`; writes audit event `Load Dispatched` |
| 6b | — (gate not satisfied) | Blocks the Dispatch action, lists missing item(s) |

**Required Fields:** Driver name, driver phone, truck number, trailer number — plus the carryover conditions from Workflow 5 (eligible carrier, carrier rate, Rate Confirmation on file).

**System Validations:** Saving individual driver/equipment fields does **not** by itself transition the load — only the explicit "Dispatch Load" action does, and only if the full gate is satisfied at that moment.

**Status Transitions:** Load: `RATE_CONFIRMATION` → `DISPATCHED`
**Audit Events:** `Load Dispatched` (actor: Dispatcher, records snapshotted driver/equipment values)

**Completion Criteria:** Load status = `DISPATCHED`, with a permanent dispatch-record snapshot of driver and equipment information.

---

## 6.2 Driver/Equipment Snapshotting

**Principle:** Whether selected from a reusable Carrier record or entered manually, the values used at the moment of dispatch are copied onto a `Dispatch Record` tied to the Load — not merely referenced by ID. If the underlying Carrier Driver/Truck/Trailer record is later edited or deactivated, this Load's historical dispatch information remains unchanged.

**Data Created:** `Dispatch Record`: load_id, driver_name, driver_phone, truck_number, trailer_number, source_driver_id (nullable, if selected from reusable record), source_truck_id (nullable), source_trailer_id (nullable), dispatched_by, dispatched_at.

**Completion Criteria:** N/A as a standalone gate — folded into 6.1's completion.

---

## 6.3 Stop Status Model

Each `Stop` on the Load (pickup or delivery) carries its own status, independent of but feeding into the overall Load status:

| Stop Status | Meaning |
|---|---|
| `PENDING` | Not yet arrived |
| `ARRIVED` | Actual arrival recorded, departure not yet recorded |
| `COMPLETED` | Both actual arrival and actual departure recorded |

**Rule:** Major Load-level transitions (6.6) are **derived from stop progress** — the Dispatcher cannot manually jump the Load's overall status without the underlying stop data supporting it.

---

## 6.4 Recording Actual Arrival (per stop)

**Trigger:** Dispatcher receives a check-in from the driver indicating arrival at a stop
**Preconditions:** Load status = `DISPATCHED` or later; target Stop status = `PENDING`

| Step | Dispatcher | System |
|---|---|---|
| 1 | Opens the relevant Stop, enters actual arrival date/time | — |
| 2 | Submits | Validates arrival time is present and chronologically reasonable (not before dispatch time) |
| 3 | — | Sets `Stop.actual_arrival`; transitions Stop status `PENDING` → `ARRIVED` |
| 4 | — | Writes audit event: `Stop Arrival Recorded` |
| 5 | — | Evaluates Load-level status transition (6.6) — e.g., first pickup arrival triggers `DISPATCHED` → `PICKUP` |

**Status Transitions (Stop):** `PENDING` → `ARRIVED`
**Audit Events:** `Stop Arrival Recorded` (actor: Dispatcher, stop reference, timestamp)

**Completion Criteria:** Stop shows a recorded actual arrival time and status `ARRIVED`.

---

## 6.5 Recording Actual Departure / Stop Completion

**Trigger:** Dispatcher receives a check-in indicating the driver has left the stop
**Preconditions:** Target Stop status = `ARRIVED`

| Step | Dispatcher | System |
|---|---|---|
| 1 | Opens the relevant Stop, enters actual departure date/time | — |
| 2 | Submits | Validates departure time is present and not before recorded arrival time |
| 3 | — | Sets `Stop.actual_departure`; transitions Stop status `ARRIVED` → `COMPLETED` |
| 4 | — | Writes audit event: `Stop Completed` |
| 5 | — | Evaluates Load-level status transition (6.6) |

**Status Transitions (Stop):** `ARRIVED` → `COMPLETED`
**Rule:** A stop is only considered complete when **both** actual arrival and actual departure are recorded — arrival alone is insufficient.
**Audit Events:** `Stop Completed` (actor: Dispatcher, stop reference, timestamp)

**Completion Criteria:** Stop shows both actual arrival and departure, status `COMPLETED`.

---

## 6.6 Load-Level Status Transitions (derived from Stop progress)

| Transition | Trigger Condition |
|---|---|
| `DISPATCHED` → `PICKUP` | Actual arrival recorded at the **first** pickup stop (Stop status → `ARRIVED` or `COMPLETED`) |
| `PICKUP` → `IN_TRANSIT` | **All** pickup stops reach `COMPLETED` (arrival + departure recorded for every pickup stop, supporting multi-pickup loads) |
| `IN_TRANSIT` → `DELIVERED` | The **final** delivery stop reaches `COMPLETED` |

| Step | Dispatcher | System |
|---|---|---|
| 1 | Records stop arrival/departure per 6.4/6.5 | — |
| 2 | — | After each stop update, re-evaluates whether the Load-level condition for its next status is now met |
| 3a | — | If condition met: transitions Load status accordingly; writes audit event `Load Status Advanced — [Status]` |
| 3b | — | If condition not yet met: Load status remains unchanged |

**System Validations:** The Load's overall status cannot be manually set ahead of what stop progress supports — e.g., a user cannot mark the Load `IN_TRANSIT` while a pickup stop is still `PENDING`.

**Status Transitions (Load):** `DISPATCHED` → `PICKUP` → `IN_TRANSIT` → `DELIVERED`
**Audit Events:** `Load Status Advanced — Pickup`, `Load Status Advanced — In Transit`, `Load Status Advanced — Delivered` (all system-generated, derived from stop completion)

**Completion Criteria:** Load status accurately reflects the aggregate state of all its stops at every point in the process; `DELIVERED` is reached only once the final delivery stop is fully completed.

---

## 6.7 Check Calls (Tracking)

**Trigger:** Dispatcher logs a check call at any point from `DISPATCHED` onward
**Preconditions:** Load status ∈ {`DISPATCHED`, `PICKUP`, `IN_TRANSIT`} (not before dispatch)

| Step | Dispatcher | System |
|---|---|---|
| 1 | Selects "Log Check Call," enters date/time, contact method, person contacted, location (city/state), ETA, on-time status, notes | — |
| 2 | Submits | Validates Load status is `DISPATCHED` or later; blocks if load has not yet been dispatched |
| 3 | — | Creates `Check Call` record; updates Load's current/last-known location and ETA |
| 4 | — | Writes audit event: `Check Call Logged` |

**System Validations:** A Check Call cannot be logged on a Load still in `RATE_CONFIRMATION` or earlier status.

**Data Created:** `Check Call` record (per PRD structure: load_id, datetime, user, contact_method, person_contacted, location, eta, on_time_status, notes)
**Audit Events:** `Check Call Logged` (actor: Dispatcher)

**Completion Criteria:** Check call is appended to the Load's chronological tracking timeline; current location/ETA reflect the latest entry.

---

## 6.8 At-Risk / Delayed Flag

**Trigger:** Dispatcher identifies a risk to on-time pickup or delivery, at any point from `DISPATCHED` onward
**Preconditions:** Load status ∈ {`DISPATCHED`, `PICKUP`, `IN_TRANSIT`}

| Step | Dispatcher | System |
|---|---|---|
| 1 | Sets Risk Status to `At Risk` or `Delayed`, enters reason (Traffic, Weather, Mechanical, Driver Issue, Appointment Issue, Customer Issue, Carrier Issue, Other) | — |
| 2 | Submits | Validates reason is present when status ≠ `Normal` |
| 3 | — | Updates `Load.risk_status` and `risk_reason`, independent of `Load.status` |
| 4 | — | Writes audit event: `Risk Status Changed` |

**Rule:** Risk Status is fully independent of the primary Load status field and can be set/cleared regardless of whether the Load is `DISPATCHED`, `PICKUP`, or `IN_TRANSIT`.

**Audit Events:** `Risk Status Changed` (actor: Dispatcher, previous/new value, reason)

**Completion Criteria:** Risk Status accurately reflects current operational judgment and is visible on the Dispatch Board independent of primary status.

---

## 6.9 Editing Driver/Equipment After Dispatch

**Trigger:** Carrier swaps driver, truck, or trailer after the Load has already been dispatched
**Preconditions:** Load status ∈ {`DISPATCHED`, `PICKUP`, `IN_TRANSIT`} (post-dispatch)

| Step | Dispatcher | System |
|---|---|---|
| 1 | Opens Dispatch Record, selects field(s) to update (driver name/phone, truck #, trailer #) | — |
| 2 | Enters new value(s), from reusable Carrier records or manual entry | — |
| 3 | Submits | Validates new value(s) present |
| 4 | — | Updates the **current** dispatch record field(s); preserves previous value(s) in field history |
| 5 | — | Writes audit event: `Dispatch Information Changed` (field, previous value, new value, user, timestamp) |

**Data Updated:** `Dispatch Record` current fields; prior values retained in audit trail (not a separate versioned table — the audit log itself is the historical record, consistent with the pattern established in Workflow 1/2).
**Audit Events:** `Dispatch Information Changed` (actor: Dispatcher, per changed field)

**Completion Criteria:** Dispatch Record reflects current driver/equipment; full change history remains reconstructable from the audit trail.

---

## 6.10 Handoff to Workflow 7

Workflow 6 ends when Load status = `DELIVERED` (final delivery stop `COMPLETED`). Workflow 7 begins with `POD RECEIVED` — uploading and processing proof-of-delivery documentation is out of scope here.

**Deferred (explicitly not built in this workflow):** No-show, pickup refused, delivery refused, and other stop-level exceptions — these require a future Exceptions workflow. This workflow covers the clean/happy path plus the At-Risk/Delayed flag only.

---

## Cross-Cutting: Permissions
- Dispatch action, stop arrival/departure recording, check call logging, risk status changes, and post-dispatch editing: Admin, Operations Manager, Dispatcher.

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Load Dispatched` | Dispatcher |
| `Stop Arrival Recorded` | Dispatcher |
| `Stop Completed` | Dispatcher |
| `Load Status Advanced — Pickup / In Transit / Delivered` | System (automatic, derived) |
| `Check Call Logged` | Dispatcher |
| `Risk Status Changed` | Dispatcher |
| `Dispatch Information Changed` | Dispatcher |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Dispatch attempted with incomplete gate (missing driver/equipment/rate con/eligible carrier) | Blocked, missing items listed |
| Attempt to manually advance Load status ahead of stop progress | Blocked — status is derived, not directly settable |
| Check Call or Risk Status attempted before `DISPATCHED` | Blocked |
| Departure recorded without prior arrival | Blocked — arrival must precede departure |
| Driver/equipment changed post-dispatch | Allowed; old and new values both preserved via audit trail |
| Stop-level exceptions (no-show, refused, etc.) | Out of scope — deferred to future Exceptions workflow |

---

*Locked as part of Stage 2 — Business Workflows. Defines the explicit Dispatch action and full-gate re-validation, driver/equipment snapshotting independent of the live Carrier record, the Stop status model (Pending/Arrived/Completed), Load status transitions strictly derived from stop progress (supporting multi-pickup loads), check calls and At-Risk/Delayed flagging from Dispatch onward, and post-dispatch editing with preserved history. Stop-level exceptions (no-show, refused, etc.) are explicitly deferred to a future Exceptions workflow.*
