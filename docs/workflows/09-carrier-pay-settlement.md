# Workflow 9: Carrier Pay & Settlement
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md), [Workflow 5](05-carrier-sourcing-assignment-rate-confirmation.md), [Workflow 6](06-dispatch-pickup-transit-delivered.md), [Workflow 7](07-pod-receipt-documentation.md), [Workflow 8](08-customer-invoicing.md)

## Actors
| Actor | Description |
|---|---|
| **Preparing User** | Accounting or Admin — creates and submits carrier payment records |
| **Approving Admin** | Admin only — reviews and approves/rejects submitted carrier payments; cannot approve their own submissions |
| **System** | The TMS application (eligibility, balance calculation, settlement generation, audit logging) |

## Trigger
A Load reaches `DELIVERED` or a later status, and the carrier is owed some or all of the agreed carrier rate (deposit, partial, or final balance).

## Preconditions
- Load status = `DELIVERED` or later.
- Acting user (Preparing User) is Active and holds Accounting or Admin role.
- Approving Admin is a distinct Active user holding the Admin role.

---

## 9.1 Carrier Pay Eligibility

| Step | Preparing User | System |
|---|---|---|
| 1 | Opens a Load with status `DELIVERED` or later | Confirms Load status qualifies |
| 2 | Selects "Create Carrier Payment" | — |

**Eligibility Rule:** Load must be `DELIVERED` or later. Carrier Pay has no dependency on Customer Invoicing status — a Load can be paid to the carrier before, after, or independent of when (or whether) it has been invoiced to the customer. POD completeness is not evaluated here; it has no effect on Carrier Pay (that check belongs exclusively to Customer Invoicing, Workflow 8).

**Completion Criteria:** Preparing User has an eligible Load open and ready to create a carrier payment record.

---

## 9.2 Carrier Payment Creation (Draft) — Amount Entry

| Step | Preparing User | System |
|---|---|---|
| 1 | Selects payment type/purpose (e.g., Deposit, Partial, Balance, Adjustment) | — |
| 2 | Enters the payment amount | System displays `Load.carrier_rate`, total already `APPROVED`/`PAID` for this Load, and the resulting remaining carrier balance, for reference |
| 3 | Enters payment method, reference number, notes (optional at Draft stage) | — |
| 4 | Saves | Validates amount > 0 |
| 5 | — | Creates `Carrier Payment` record: load_id, carrier_id, amount, type, method, reference, notes, status = `DRAFT`, prepared_by, created_at |
| 6 | — | Writes audit event: `Carrier Payment Created — Draft` |

**Required Fields:** Amount, payment type. Method/reference/notes may be completed before submission for approval (9.3).

**Status Assignment:** New Carrier Payment always starts at `DRAFT`.
**Data Created:** `Carrier Payment` record: load_id, carrier_id, amount, type, method, reference, notes, status = Draft, prepared_by, created_at.
**Audit Events:** `Carrier Payment Created — Draft` (actor: Preparing User)

**Completion Criteria:** A `DRAFT` Carrier Payment record exists with a specified amount, ready for submission.

---

## 9.3 Draft → Pending Approval (Submission)

**Trigger:** Preparing User submits the Draft payment for approval
**Preconditions:** Carrier Payment status = `DRAFT`; amount is set

| Step | Preparing User | System |
|---|---|---|
| 1 | Reviews the Draft payment, confirms amount and details are final | — |
| 2 | Selects "Submit for Approval" | Validates amount, method, and reference are present |
| 3 | — | Transitions Carrier Payment status: `DRAFT` → `PENDING_APPROVAL` |
| 4 | — | Writes audit event: `Carrier Payment Submitted for Approval` |

**System Validations:** The amount is locked in at submission — this is the specific amount the Approving Admin will review. It cannot be edited while `PENDING_APPROVAL` (only reverted to Draft via rejection, 9.5).

**Status Transitions:** Carrier Payment: `DRAFT` → `PENDING_APPROVAL`
**Audit Events:** `Carrier Payment Submitted for Approval` (actor: Preparing User)

**Completion Criteria:** Carrier Payment status = `PENDING_APPROVAL`, visible to Approving Admins for review.

---

## 9.4 Admin Approval / Rejection

**Trigger:** Approving Admin opens a `PENDING_APPROVAL` Carrier Payment
**Preconditions:** Acting user holds Admin role **and** is not the Preparing User who submitted this specific payment

| Step | Approving Admin | System |
|---|---|---|
| 1 | Opens the pending payment, reviews carrier, load, amount, method, reference | — |
| 2 | — | Verifies approver ≠ preparer for this record; if approver is the preparer, **blocks the approval action** |
| 3a | Selects "Approve" | Transitions Carrier Payment status: `PENDING_APPROVAL` → `APPROVED`; records approved_amount (= submitted amount, unchanged), approved_by, approved_at |
| 3b | Selects "Reject", enters rejection reason (required) | Transitions Carrier Payment status: `PENDING_APPROVAL` → `DRAFT`; records rejected_by, rejected_at, rejection_reason (see 9.5) |
| 4 | — | Writes audit event: `Carrier Payment Approved` or `Carrier Payment Rejected` |

**System Validations**
- Approver must hold Admin role.
- Approver must not be the Preparing User (self-approval blocked).
- The Approving Admin **approves or rejects the submitted amount as-is** — the amount field itself is not editable during approval. If the amount is wrong, the payment must be rejected and revised, not corrected in place.
- Rejection requires a non-empty reason.

**Status Transitions:** Carrier Payment: `PENDING_APPROVAL` → `APPROVED` | `DRAFT` (on rejection)
**Data Updated:** `Carrier Payment.status`, `approved_by`/`approved_at` (on approval) or `rejected_by`/`rejected_at`/`rejection_reason` (on rejection)
**Audit Events:** `Carrier Payment Approved` (actor: Approving Admin, amount) / `Carrier Payment Rejected` (actor: Approving Admin, reason)

**Completion Criteria:** Carrier Payment reaches `APPROVED` (ready for processing, 9.6) or returns to `DRAFT` for revision (9.5).

---

## 9.5 Rejection & Revision Loop

**Trigger:** A Carrier Payment is rejected per 9.4

| Step | Preparing User | System |
|---|---|---|
| 1 | Views rejection reason on the payment (now back in `DRAFT`) | — |
| 2 | Revises amount, method, reference, or notes as needed | — |
| 3 | Re-submits for approval | Re-enters the flow at 9.3 (Draft → Pending Approval) |

**Rule:** A rejected payment **cannot** proceed directly to `PAID` — it must return through `DRAFT` and be resubmitted, going through the full approval cycle again (including the no-self-approval check). The original rejection (reason, rejecting Admin, timestamp) remains permanently in the audit trail even after the payment is later approved and paid.

**Status Transitions:** Carrier Payment: `PENDING_APPROVAL` → `DRAFT` → `PENDING_APPROVAL` → ... (cycles as needed, no limit specified)
**Audit Events:** Already captured at rejection (9.4); resubmission captured again at 9.3.

**Completion Criteria:** Rejected payment is either successfully revised and re-approved, or remains in `DRAFT` pending further revision.

---

## 9.6 Payment Processing (Approved → Paid)

**Trigger:** Preparing User (or any Accounting/Admin user) marks an `APPROVED` payment as processed
**Preconditions:** Carrier Payment status = `APPROVED`

| Step | Preparing User | System |
|---|---|---|
| 1 | Confirms payment has been issued to the carrier (e.g., check sent, ACH processed) | — |
| 2 | Enters/confirms payment date | Validates status is `APPROVED` (a payment cannot be marked `PAID` from any other status) |
| 3 | Selects "Mark as Paid" | Transitions Carrier Payment status: `APPROVED` → `PAID`; sets `paid_at` |
| 4 | — | Generates settlement document (9.8) |
| 5 | — | Recalculates carrier balance for the Load (9.7) |
| 6 | — | Writes audit event: `Carrier Payment Paid` |

**System Validations:** Only an `APPROVED` payment can be marked `PAID` — this transition is unavailable from `DRAFT` or `PENDING_APPROVAL`.

**Status Transitions:** Carrier Payment: `APPROVED` → `PAID`
**Audit Events:** `Carrier Payment Paid` (actor: Preparing/Accounting User, amount, date)

**Completion Criteria:** Carrier Payment status = `PAID`; settlement document generated; Load's carrier balance updated.

---

## 9.7 Multiple / Partial Payments & Carrier Balance Tracking

**Principle:** A Load can have any number of Carrier Payment records (deposit, partial, balance, adjustment), each independently progressing through its own `DRAFT → PENDING_APPROVAL → APPROVED → PAID` cycle (9.2–9.6).

| Step | Preparing User | System |
|---|---|---|
| 1 | Creates additional Carrier Payment record(s) as needed (9.2) | — |
| 2 | — | Each payment is tracked and approved independently |
| 3 | — | System continuously computes: `total_paid = SUM(amount) WHERE status = PAID`; `remaining_carrier_balance = Load.carrier_rate − total_paid` |
| 4 | — | Displays `total_paid` and `remaining_carrier_balance` on the Load record |

**Data Maintained:** `Load.carrier_rate` (unchanged, source of truth per Workflow 5), computed `total_paid`, computed `remaining_carrier_balance` — derived live from the sum of `PAID` Carrier Payment records, not stored as a separately editable field.

**Completion Criteria:** At any point, the Load accurately reflects how much has been paid to the carrier and how much remains, based solely on `PAID` payment records.

---

## 9.8 Settlement Document Generation

**Trigger:** A Carrier Payment transitions to `PAID` (step 4 of 9.6)
**Preconditions:** Carrier Payment status just became `PAID`

| Step | Preparing User | System |
|---|---|---|
| 1 | — | Generates a settlement document summarizing **this specific payment**: carrier, load, this payment's amount, method, reference, date, and applicable charge/accessorial breakdown for context |
| 2 | — | Creates `Document` record: type = Carrier Settlement, associated with this Carrier Payment (and the Load), version = 1 |
| 3 | — | Writes audit event: `Settlement Document Generated` |

**Rule:** One settlement document is generated **per payment**, not per load — a Load with three separate carrier payments (deposit, partial, balance) will have three distinct settlement documents, each reflecting only the specific payment it was generated for.

**Documents Generated:** Carrier Settlement Document (PDF), one per `PAID` Carrier Payment.
**Audit Events:** `Settlement Document Generated` (system-generated, tied to the specific payment)

**Completion Criteria:** Every `PAID` Carrier Payment has exactly one corresponding settlement document accurately reflecting that individual payment.

---

## 9.9 Handoff to Workflow 10

Workflow 9 ends once carrier payment(s) for a Load are recorded as `PAID` (in full or in part, per the Load's needs) and their settlement documents exist. Whether the Load's carrier balance is fully paid off, partially paid, or not yet paid at all, this workflow's job is simply to accurately track and process whatever payments are prepared, approved, and processed. **Load Closing** — the "clean close" checklist that references both Customer Invoice status and Carrier Pay status together — is defined in **Workflow 10**.

---

## Cross-Cutting: Permissions
- Carrier payment creation/submission: Accounting and Admin.
- Carrier payment approval: Admin only, and never the same user who prepared/submitted that specific payment.
- Marking a payment as Paid: same as creation (Accounting and Admin).

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Carrier Payment Created — Draft` | Preparing User |
| `Carrier Payment Submitted for Approval` | Preparing User |
| `Carrier Payment Approved` | Approving Admin |
| `Carrier Payment Rejected` | Approving Admin (with reason) |
| `Carrier Payment Paid` | Preparing/Accounting User |
| `Settlement Document Generated` | System (automatic, per payment) |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Load not yet `DELIVERED` | Not eligible for carrier payment creation |
| Preparer attempts to approve their own submitted payment | Blocked with explanation |
| Approver attempts to edit the amount during approval | Not possible — approve/reject the submitted amount as-is; must reject to trigger revision |
| Rejection without reason | Blocked until reason entered |
| Attempt to mark a non-`APPROVED` payment as `PAID` | Blocked — only `APPROVED` payments can be marked Paid |
| Payment rejected | Returns to `DRAFT`; must be revised and resubmitted through the full approval cycle again |

---

*Locked as part of Stage 2 — Business Workflows. Defines carrier-pay eligibility independent of Customer Invoicing and POD status, Draft creation with amount entry, submission for approval, mandatory Admin approval with a strict no-self-approval and no-amend-on-approval rule (reject-to-revise only), the Draft↔Pending-Approval revision loop, per-payment settlement document generation, and live-computed carrier balance tracking across any number of independent payment records per load. Load Closing, which references both this workflow and Workflow 8 together, is defined in Workflow 10.*
