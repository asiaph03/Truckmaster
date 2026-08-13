# Workflow 10: Load Closing
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows (Final Core Workflow)
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md), [Workflow 5](05-carrier-sourcing-assignment-rate-confirmation.md), [Workflow 6](06-dispatch-pickup-transit-delivered.md), [Workflow 7](07-pod-receipt-documentation.md), [Workflow 8](08-customer-invoicing.md), [Workflow 9](09-carrier-pay-settlement.md)

## Actors
| Actor | Description |
|---|---|
| **Closing User** | Accounting, Admin, or Operations Manager — reviews the closing checklist and closes the load |
| **System** | The TMS application (checklist evaluation, warning display, audit logging) |

## Trigger
A Closing User determines a Load has reached the end of its operational and financial lifecycle and opens it to close it out.

## Preconditions
- Load exists (any status — in practice this action is meaningful once a Load is `DELIVERED` or later, but the system does not restrict which statuses are eligible to view the checklist).
- Acting user is Active and holds Accounting, Admin, or Operations Manager role.

---

## 10.1 Closing Readiness Checklist Evaluation

**Trigger:** Closing User opens the "Close Load" view for a Load
**Preconditions:** None beyond role permission — the checklist can be viewed at any time to check progress, independent of whether the user intends to close immediately

| Step | Closing User | System |
|---|---|---|
| 1 | Opens "Close Load" on the Load | Evaluates each checklist item (10.2–10.5) against current Load data |
| 2 | — | Displays the full checklist with each item's status, clearly distinguishing **Clean/Complete** items from **Warning** items |

**Checklist Items:**
| Item | Clean/Complete | Warning |
|---|---|---|
| Rate Confirmation | On file | Missing |
| POD | `pod_status = COMPLETE` | `PARTIAL` or `NOT_RECEIVED` |
| Customer Invoice | Invoice exists for the Load (any status) | No invoice exists |
| Carrier Pay | At least one Carrier Payment record exists for the Load | No payment record exists |

**Completion Criteria:** N/A as a gate — this is a read-only evaluation step. Its output feeds the Close action (10.7).

---

## 10.2 Rate Confirmation Check

| Step | Closing User | System |
|---|---|---|
| 1 | — | Checks whether a Rate Confirmation `Document` exists on the Load (per Workflow 5) |
| 2a | — (exists) | Displays "Rate Confirmation: On file" — Clean |
| 2b | — (does not exist) | Displays "Rate Confirmation: Missing" — Warning |

**Note:** In practice, a Load cannot reach `DISPATCHED` or later without a Rate Confirmation on file (per Workflow 5's hard gate) — this check exists primarily as a defensive/visibility item on the checklist rather than a realistic failure case for loads that progressed normally through dispatch.

---

## 10.3 POD Milestone Check

| Step | Closing User | System |
|---|---|---|
| 1 | — | Reads current `Load.pod_status` (per Workflow 7) |
| 2a | — (`COMPLETE`) | Displays "POD: Complete" — Clean |
| 2b | — (`PARTIAL`) | Displays "POD: Partial" — Warning |
| 2c | — (`NOT_RECEIVED`) | Displays "POD: Not Received" — Warning |

**Rule:** `COMPLETE` is the only clean state; both `PARTIAL` and `NOT_RECEIVED` surface as warnings but never block closing.

---

## 10.4 Customer Invoice Check

| Step | Closing User | System |
|---|---|---|
| 1 | — | Checks whether any `Invoice` record references this Load (per Workflow 8) |
| 2a | — (invoice exists, any status) | Displays "Customer Invoice: Exists" — Clean |
| 2b | — (no invoice exists) | Displays "Customer Invoice: Missing" — Warning |

**Rule:** Readiness requires only that an invoice **exists** for the Load — it does **not** need to be `PAID`. An invoice in `DRAFT`, `SENT`, `PARTIALLY_PAID`, `OVERDUE`, or any other non-terminal status still satisfies this checklist item as Clean.

---

## 10.5 Carrier Pay Check

| Step | Closing User | System |
|---|---|---|
| 1 | — | Checks whether any `Carrier Payment` record exists for this Load (per Workflow 9); computes `remaining_carrier_balance` |
| 2a | — (at least one payment record exists) | Displays "Carrier Pay: Payment recorded" — Clean; also displays `remaining_carrier_balance` if greater than zero |
| 2b | — (no payment record exists) | Displays "Carrier Pay: No payment recorded" — Warning |

**Rule:** Readiness requires only that a payment record **exists** — the carrier does **not** need to be fully paid off. If a remaining balance exists (even on an otherwise "Clean" item), it is shown alongside the Clean status as informational context, not as a separate warning state.

---

## 10.6 Warning / Acknowledgment Behavior

| Step | Closing User | System |
|---|---|---|
| 1 | Reviews the full checklist (10.1–10.5) | — |
| 2a | — (all items Clean) | Displays "Ready to close" — no acknowledgment required |
| 2b | — (one or more Warning items present) | Displays each warning item clearly; no reason/note field is required |
| 3 | Proceeds to close (10.7) regardless of checklist state | — |

**Rule:** There is **no hard blocker** anywhere in this workflow. Warnings inform the Closing User's judgment but never prevent the Close action. No reason or note is required to close with incomplete items — the explicit act of clicking "Close Load" while warnings are visible is itself sufficient acknowledgment.

**Key distinction maintained throughout:** "ready for a clean close" (all checklist items Clean) is a different concept from "allowed to close" (always true for an authorized user, regardless of checklist state).

---

## 10.7 Close Action

**Trigger:** Closing User clicks "Close Load"
**Preconditions:** Load is not already `CLOSED`

| Step | Closing User | System |
|---|---|---|
| 1 | Clicks "Close Load" (checklist already visible per 10.6, whether Clean or with warnings) | — |
| 2 | — | Transitions Load status → `CLOSED` |
| 3 | — | Writes audit event: `Load Closed`, capturing the full checklist snapshot at the moment of closing (which items were Clean vs. Warning) |

**Data Updated:** `Load.status` = `CLOSED`, `Load.closed_by`, `Load.closed_at`
**Audit Events:** `Load Closed` (actor: Closing User, includes checklist snapshot: Rate Confirmation status, POD status, Invoice existence, Carrier Pay status/balance at time of closing)

**Completion Criteria:** Load status = `CLOSED`; the checklist state at the moment of closing is permanently captured in the audit trail, regardless of whether it was fully Clean or had outstanding warnings.

---

## 10.8 Post-Close Editing Behavior

**Principle:** `CLOSED` is a lifecycle/completion milestone, not a data-immutability lock. Authorized users may still make legitimate corrections after closing.

| Action | Allowed After `CLOSED`? |
|---|---|
| Uploading additional documents (e.g., a late POD) | ✅ Allowed (per Workflow 7, timing-independent) |
| Adding a credit/debit adjustment to the customer invoice | ✅ Allowed (per Workflow 8) |
| Recording an additional carrier payment | ✅ Allowed (per Workflow 9) |
| Editing reference numbers | ✅ Allowed (per Workflow 4) |
| Any other authorized edit | ✅ Allowed, subject to normal role permissions |

**Rule:** No dedicated "Reopen" action exists in V1. A `CLOSED` Load does not need to be reopened to receive corrections — normal authorized editing and adjustment mechanisms already established in Workflows 4–9 continue to function on a `CLOSED` Load exactly as they do on any other status. Every such change is captured in the audit trail as usual (actor, timestamp, previous/new value).

**Completion Criteria:** N/A as a gate — this is a standing behavioral rule for the `CLOSED` state.

---

## 10.9 Final Stage 2 Workflow Boundary

Workflow 10 is the **final workflow in the core Stage 2 load lifecycle sequence**, completing the path: Organization/User Onboarding (1) → Customer Creation (2) → Carrier Onboarding & Compliance (3) → Quote/Load Creation & Booking (4) → Carrier Sourcing, Assignment & Rate Confirmation (5) → Dispatch → Pickup → In Transit → Delivered (6) → POD Receipt & Documentation (7) → Customer Invoicing (8) → Carrier Pay & Settlement (9) → Load Closing (10).

**Explicitly out of scope for this core sequence** (candidates for future, separate workflow documents): stop-level Exceptions (No-show, Pickup Refused, Delivery Refused, etc.), Bulk Import, Organization Settings, Dispatch Board operational mechanics, Reporting/Dashboard mechanics, and any future portal/AI/integration workflows.

---

## Cross-Cutting: Permissions
- Viewing the closing checklist and performing the Close action: Accounting, Admin, Operations Manager.

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Load Closed` | Closing User (includes full checklist snapshot) |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| One or more checklist items incomplete | Displayed as warnings; closing proceeds without a reason/note required |
| Rate Confirmation missing | Warning shown (rare in practice, since Dispatch requires it) |
| POD `PARTIAL` or `NOT_RECEIVED` | Warning shown, never blocks |
| No Customer Invoice exists | Warning shown; invoice does not need to be Paid, only to exist, to be Clean |
| No Carrier Payment recorded | Warning shown; carrier does not need to be fully paid, only to have a payment record, to be Clean |
| Attempt to "reopen" a Closed load | No such action exists — corrections are made via normal editing/adjustment workflows directly on the Closed load |

---

*Locked as part of Stage 2 — Business Workflows. Defines the non-blocking closing readiness checklist (Rate Confirmation, POD milestone, Customer Invoice existence, Carrier Pay existence with remaining-balance visibility), the Clean-vs-Warning distinction with no reason required to proceed past warnings, the Close action itself with a permanently captured checklist snapshot, and post-close editing behavior confirming `CLOSED` is a milestone rather than an immutability lock — with no dedicated Reopen action in V1. This is the final workflow in the core Stage 2 load lifecycle sequence; stop-level Exceptions, Bulk Import, Organization Settings, Dispatch Board mechanics, and Reporting mechanics are explicitly deferred to future, separate workflow documents.*
