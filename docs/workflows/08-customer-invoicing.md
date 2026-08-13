# Workflow 8: Customer Invoicing
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md), [Workflow 5](05-carrier-sourcing-assignment-rate-confirmation.md), [Workflow 6](06-dispatch-pickup-transit-delivered.md), [Workflow 7](07-pod-receipt-documentation.md)

## Actors
| Actor | Description |
|---|---|
| **Accounting User** | Accounting or Admin — creates, sends, and manages invoices; records payments and adjustments |
| **System** | The TMS application (eligibility filtering, numbering, due-date calculation, status computation, audit logging) |

## Trigger
One or more Loads reach `DELIVERED` or a later status, making them eligible to be billed to the customer.

## Preconditions
- At least one Load exists with status `DELIVERED` or later, and has not yet been invoiced.
- Acting user is Active and holds Accounting or Admin role.

---

## 8.1 Ready-to-Invoice Queue & Eligibility

| Step | Accounting User | System |
|---|---|---|
| 1 | Opens the "Ready to Invoice" queue | Filters Loads to those with status `DELIVERED` or later, `invoiced = false` (not yet on any invoice) |
| 2 | Searches/filters by customer, lane, date, etc. | Displays matching eligible Loads with key details (load number, customer, charges total, `pod_status`) |
| 3 | Selects one Load (individual invoice) or multiple Loads for the same customer (consolidated invoice) | — |

**Eligibility Rule:** A Load qualifies for invoicing once its status is `DELIVERED` or any later status (`CUSTOMER_INVOICED` itself is excluded, since that would mean it's already invoiced). `pod_status` does not affect eligibility — only triggers a warning (8.2).

**One-Invoice-Per-Load Rule:** Once a Load is included on any invoice (Draft or later), it is marked `invoiced = true` and removed from the Ready to Invoice queue — preventing it from being selected for a second invoice. A Load's total customer charges are invoiced exactly once.

**Completion Criteria:** Accounting User has selected one or more eligible Loads for a single customer to proceed to invoice creation.

---

## 8.2 POD Warning Acknowledgment

**Trigger:** Occurs during invoice creation (8.3/8.4), evaluated across all selected Loads

| Step | Accounting User | System |
|---|---|---|
| 1 | Proceeds to create the invoice from selected Load(s) | Checks `pod_status` on each selected Load |
| 2a | — (all Loads have `pod_status = COMPLETE`) | No warning shown; proceeds directly to invoice creation |
| 2b | — (any Load has `pod_status = NOT_RECEIVED` or `PARTIAL`) | Displays acknowledgment dialog: *"POD incomplete — This invoice contains a load with missing or incomplete POD documentation."* with **Cancel** / **Proceed Anyway** |
| 3a | Selects "Cancel" | Returns to Load selection; no invoice created |
| 3b | Selects "Proceed Anyway" | Writes audit event `Invoice Created Despite Incomplete POD` (records which Load(s) triggered the warning); proceeds to invoice creation |

**Nature of Check:** Warning only — never blocks invoicing, per the PRD.

**Audit Events:** `Invoice Created Despite Incomplete POD` (actor: Accounting User, only when "Proceed Anyway" is chosen)

**Completion Criteria:** Either no incomplete-POD Loads are present, or the user has explicitly acknowledged and proceeded (captured in the audit trail).

---

## 8.3 Individual Invoice Creation (one Load)

**Preconditions:** Exactly one eligible Load selected; POD warning resolved (8.2) if applicable

| Step | Accounting User | System |
|---|---|---|
| 1 | Confirms the single selected Load | — |
| 2 | — | Auto-populates invoice line items directly from the Load's Charge Line Items (Linehaul, Fuel Surcharge, accessorials — each as its own line) |
| 3 | Reviews line items; may edit/add/remove lines before sending | — |
| 4 | Saves | Generates invoice number (8.7); creates `Invoice` record: status = `DRAFT`, customer_id, load_ids = [this Load], line_items (from Load), total |
| 5 | — | Marks the Load `invoiced = true` |
| 6 | — | Writes audit event: `Invoice Created — Individual` |

**Data Created:** `Invoice` record (status = Draft) + `Invoice Line Item` records copied from the Load's Charge Line Items.
**Audit Events:** `Invoice Created — Individual` (actor: Accounting User, load reference)

**Completion Criteria:** A `DRAFT` invoice exists, referencing exactly one Load, with line items populated from that Load's charges.

---

## 8.4 Consolidated Invoice Creation (multiple Loads, one customer)

**Preconditions:** Two or more eligible Loads selected, all belonging to the same Customer; POD warning resolved (8.2) if applicable

| Step | Accounting User | System |
|---|---|---|
| 1 | Confirms the selected Loads (same customer; lanes/equipment types may be mixed freely) | Validates all selected Loads belong to the same customer |
| 2 | — | Creates `Invoice` record: status = `DRAFT`, customer_id, load_ids = [selected Loads] |
| 3 | — | Populates invoice line items: **one line per Load**, showing load number and that Load's total customer charges (see 8.5) |
| 4 | Reviews consolidated invoice | — |
| 5 | Saves | Generates invoice number (8.7) |
| 6 | — | Marks all included Loads `invoiced = true` |
| 7 | — | Writes audit event: `Invoice Created — Consolidated` (records all included load numbers) |

**Data Created:** `Invoice` record (status = Draft) + one `Invoice Line Item` per included Load.
**Audit Events:** `Invoice Created — Consolidated` (actor: Accounting User, all load references)

**Completion Criteria:** A `DRAFT` invoice exists, referencing multiple Loads for one Customer, with one summary line per Load.

---

## 8.5 Line-Item Handling

| Invoice Type | Line-Item Display | Underlying Detail |
|---|---|---|
| Individual | One line per Charge Line Item on the Load (Linehaul, Fuel Surcharge, each accessorial, etc.) | N/A — already at full detail |
| Consolidated | One line per Load (load number + total customer charges for that Load) | The full Charge Line Item detail remains on each underlying Load record, not duplicated onto the invoice line — a user can drill into a Load to see its breakdown |

**Rule:** In both cases, the invoice always references its source Load(s); charge detail is never lost, only summarized differently for consolidated display.

---

## 8.6 Draft → Send

**Trigger:** Accounting User selects "Send Invoice" on a `DRAFT` invoice
**Preconditions:** Invoice status = `DRAFT`

| Step | Accounting User | System |
|---|---|---|
| 1 | Reviews/edits the Draft invoice (line items, amounts) | — |
| 2 | Selects "Send Invoice" | Validates invoice has at least one line item and a total > 0 |
| 3 | — | Calculates `due_date` = today (send date) + `Customer.payment_terms` (8.8) |
| 4 | — | Transitions Invoice status: `DRAFT` → `SENT` |
| 5 | — | Writes audit event: `Invoice Sent` |
| 6 | *(Optional)* Sends invoice PDF via email (per existing transactional email capability) | Logs send activity if emailed |

**Status Transitions:** Invoice: `DRAFT` → `SENT`
**Data Updated:** `Invoice.status`, `Invoice.sent_at`, `Invoice.due_date`
**Audit Events:** `Invoice Sent` (actor: Accounting User)

**Completion Criteria:** Invoice status = `SENT`, with a due date calculated and set.

---

## 8.7 Invoice Numbering

| Step | Accounting User | System |
|---|---|---|
| 1 | Saves a new invoice (individual or consolidated) as `DRAFT` | Generates the invoice number (`INV-000001`), org-scoped and sequential, at the moment the Draft is created — not deferred to Send |

**Completion Criteria:** Every `DRAFT` invoice has a permanent, unique invoice number from the moment of creation.

---

## 8.8 Due Date Calculation

**Rule:** `Invoice.due_date` = `Invoice.sent_at` (the date the invoice transitions to `SENT`, per 8.6) + `Customer.payment_terms` (e.g., Net 30 → due date = send date + 30 days).

**Note:** The due date is **not** calculated at Draft creation — a Draft has no due date until it is actually sent, since the payment clock starts at Send.

**Completion Criteria:** Every `SENT` invoice has a due date consistent with the customer's payment terms as of the send date.

---

## 8.9 Payment Recording (including Partial Payments)

**Trigger:** Accounting User records a payment received against an invoice
**Preconditions:** Invoice status = `SENT`, `PARTIALLY_PAID`, or `OVERDUE` — never `DRAFT`

| Step | Accounting User | System |
|---|---|---|
| 1 | Opens invoice, selects "Record Payment" | Validates invoice status is not `DRAFT` |
| 2 | Enters payment amount, date, method, reference number, notes | — |
| 3 | Submits | Validates amount > 0; creates `Payment` record: invoice_id, amount, date, method, reference, notes, recorded_by |
| 4 | — | Recalculates: `remaining_balance = Invoice.total − SUM(payments)` |
| 5 | — | Derives new Invoice status (see table below) |
| 6 | — | Writes audit event: `Payment Recorded` |

**Derived Status Logic:**
| Condition | Invoice Status |
|---|---|
| `remaining_balance = Invoice.total` (no payments yet) | `SENT` (or `OVERDUE` if past due — 8.10) |
| `0 < remaining_balance < Invoice.total` | `PARTIALLY_PAID` |
| `remaining_balance = 0` | `PAID` |

**System Validations:** Payment cannot be recorded against a `DRAFT` invoice — the invoice must have been sent first.

**Data Created:** `Payment` record (supports multiple per invoice)
**Data Updated:** Derived `Invoice.status`, `Invoice.remaining_balance`
**Audit Events:** `Payment Recorded` (actor: Accounting User, amount, method, reference)

**Completion Criteria:** Every payment is individually recorded; invoice status always reflects total payments received versus invoice total.

---

## 8.10 Overdue Handling (computed, not scheduled)

**Rule:** `OVERDUE` is a **computed display status**, evaluated whenever the invoice is viewed/queried: `due_date < today AND remaining_balance > 0`. No scheduled background job is required to maintain it — it is derived at read time from `due_date` and `remaining_balance`, both of which are already accurately maintained by 8.6 and 8.9.

**Completion Criteria:** Any `SENT` or `PARTIALLY_PAID` invoice past its due date with a remaining balance is correctly displayed/reported as `OVERDUE` wherever invoice status is shown (dashboards, AR aging, etc.), without requiring a separate stored state to be kept in sync.

---

## 8.11 Credit / Debit Adjustments

**Trigger:** Accounting User needs to adjust a `SENT` (or later-status) invoice — e.g., a disputed charge, a correction
**Preconditions:** Invoice status is `SENT`, `PARTIALLY_PAID`, `PAID`, or `OVERDUE` (i.e., already sent — not `DRAFT`, which can simply be edited directly per 8.6)

| Step | Accounting User | System |
|---|---|---|
| 1 | Opens invoice, selects "Add Adjustment" | — |
| 2 | Selects type (Credit or Debit), enters amount, reason, notes | — |
| 3 | Submits | Validates amount > 0 and reason is non-empty |
| 4 | — | Creates `Adjustment` record: invoice_id, type, amount, reason, date, created_by |
| 5 | — | Recalculates `remaining_balance` incorporating the adjustment; re-derives invoice status (8.9 logic, adjustment-inclusive) |
| 6 | — | Writes audit event: `Invoice Adjustment Created` |

**No additional approval workflow** — any Accounting or Admin user may create an adjustment directly, same permission as invoicing generally.

**Data Created:** `Adjustment` record (Credit or Debit), permanently retained alongside the original invoice — the original invoice line items/total are never altered in place.
**Audit Events:** `Invoice Adjustment Created` (actor: Accounting User, type, amount, reason)

**Completion Criteria:** Adjustment is recorded as its own permanent entry; invoice balance and status reflect it; original invoice history remains intact.

---

## 8.12 Void / Credited Status

**Trigger:** Accounting User needs to void an invoice entirely (e.g., created in error)

| Step | Accounting User | System |
|---|---|---|
| 1 | Selects "Void Invoice" | — |
| 2 | Confirms | Transitions Invoice status → `VOID`; releases included Load(s) back to `invoiced = false` (eligible for a new invoice) |
| 3 | — | Writes audit event: `Invoice Voided` |

**`CREDITED` status:** applied when an invoice's balance has been fully offset via Credit Adjustments (8.11) rather than payment — a fully credited invoice is marked `CREDITED` instead of `PAID`, preserving the distinction for reporting.

**Status Transitions:** Invoice: any pre-Void status → `VOID`; or `SENT`/`PARTIALLY_PAID`/`OVERDUE` → `CREDITED` (when fully offset by credit adjustments)
**Audit Events:** `Invoice Voided`

**Completion Criteria:** Voided invoices free their Loads for re-invoicing; credited invoices are distinguishable from paid ones in reporting.

---

## Full Invoice Status Reference

```
DRAFT → SENT → PARTIALLY_PAID → PAID
                    ↓
                 OVERDUE  (computed: due_date passed + balance > 0)
Any pre-Void status → VOID
SENT/PARTIALLY_PAID/OVERDUE → CREDITED  (fully offset by adjustments)
```

---

## 8.13 Handoff to Workflow 9

Workflow 8 covers customer invoice creation, sending, payment recording, partial payments, overdue computation, and credit/debit adjustments. **Carrier Pay is entirely out of scope** — a Load reaching `CUSTOMER_INVOICED` (or its invoice reaching any status) has no bearing on carrier payment, which is defined separately in **Workflow 9 (Carrier Pay & Settlement)**.

---

## Cross-Cutting: Permissions
- Invoice creation (individual and consolidated), sending, payment recording, and credit/debit adjustments: Accounting and Admin only.

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Invoice Created Despite Incomplete POD` | Accounting User (only when warning acknowledged) |
| `Invoice Created — Individual` | Accounting User |
| `Invoice Created — Consolidated` | Accounting User |
| `Invoice Sent` | Accounting User |
| `Payment Recorded` | Accounting User |
| `Invoice Adjustment Created` | Accounting User |
| `Invoice Voided` | Accounting User |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Load not yet `DELIVERED` | Not eligible — excluded from Ready to Invoice queue |
| Load already invoiced | Excluded from queue — cannot be selected for a second invoice |
| Selected Loads span multiple customers (consolidated) | Blocked — consolidated invoice requires a single customer |
| POD incomplete on any selected Load | Warning shown; user must Cancel or explicitly Proceed Anyway (audited) |
| Payment attempted against a `DRAFT` invoice | Blocked — invoice must be `SENT` or later |
| Invoice sent with no line items / zero total | Blocked |
| Invoice voided | Included Load(s) released back to Ready to Invoice queue |

---

*Locked as part of Stage 2 — Business Workflows. Defines the Ready-to-Invoice eligibility queue, the non-blocking POD-incomplete acknowledgment warning, individual invoices (full line-item detail) versus consolidated invoices (one line per Load, detail preserved on the Load), the Draft→Send lifecycle with numbering at Draft creation and due-date calculation at Send, payment recording with derived status (including computed Overdue with no scheduled job required), and credit/debit adjustments and Void/Credited handling that never alter original invoice history. Carrier Pay is fully out of scope, deferred to Workflow 9.*
