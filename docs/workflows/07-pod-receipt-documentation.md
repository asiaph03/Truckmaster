# Workflow 7: POD Receipt & Documentation
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md), [Workflow 2](02-customer-creation.md), [Workflow 3](03-carrier-onboarding-compliance.md), [Workflow 4](04-quote-load-creation-booking.md), [Workflow 5](05-carrier-sourcing-assignment-rate-confirmation.md), [Workflow 6](06-dispatch-pickup-transit-delivered.md)

## Actors
| Actor | Description |
|---|---|
| **Uploading User** | Admin, Operations Manager, Dispatcher, or Accounting — uploads POD documents |
| **System** | The TMS application (document association, milestone derivation, audit logging) |

## Trigger
A Proof of Delivery document becomes available (driver sends a photo/scan, customer emails a signed copy, etc.), and an authorized user uploads it against the relevant delivery stop.

## Preconditions
- Load exists with at least one delivery stop.
- Acting user is Active and holds Admin, Operations Manager, Dispatcher, or Accounting role.

---

## 7.1 POD Upload (per delivery stop)

**Trigger:** Uploading User uploads a POD file
**Preconditions:** None required on Load status — upload is allowed at any point, including before `DELIVERED`, at `DELIVERED`, or after the Load has moved into any downstream status (e.g., `CUSTOMER_INVOICED`).

| Step | Uploading User | System |
|---|---|---|
| 1 | Opens the Load, selects the specific **delivery Stop** the POD applies to | — |
| 2 | Selects document type = `POD`, uploads file | — |
| 3 | *(Optional)* Adds notes | — |
| 4 | Submits | Validates file type/size (per general Document rules); validates a delivery Stop was selected |
| 5 | — | Creates `Document` record: type = POD, associated_entity = Stop (and, by extension, the parent Load), version = 1, uploaded_by, uploaded_at |
| 6 | — | Writes audit event: `POD Uploaded` |
| 7 | — | Recalculates the Load-level POD milestone (see 7.2) |

**No approval step:** unlike carrier compliance documents (Workflow 3), a POD requires no reviewer sign-off. Upload alone counts as "received" for milestone purposes.
**No notifications:** upload does not trigger any notification in V1 (Accounting will see POD status when working the Load, e.g., during invoicing in Workflow 8).

**Required Fields:** Document type = POD, file, associated delivery Stop.
**Data Created:** `Document` record (type = POD), linked to a specific delivery Stop.
**Audit Events:** `POD Uploaded` (actor: Uploading User, stop reference)

**Completion Criteria:** A POD `Document` record exists, associated with a specific delivery Stop on the Load.

---

## 7.2 Load-Level POD Milestone Derivation

**Principle:** `POD_RECEIVED` is a **derived milestone/flag** on the Load (`Load.pod_status`), not the primary Load status. It is computed from delivery-stop-level documentation, not set directly by a user action.

| `Load.pod_status` | Condition |
|---|---|
| `NOT_RECEIVED` | No delivery stop has an associated POD document |
| `PARTIAL` | At least one, but not all, delivery stops have an associated POD document |
| `COMPLETE` | **Every** delivery stop on the Load has at least one associated POD document |

| Step | Uploading User | System |
|---|---|---|
| 1 | Uploads/removes a POD document on any delivery stop (7.1 or 7.3) | — |
| 2 | — | Recalculates `Load.pod_status` by checking POD presence across all delivery stops |
| 3 | — | Writes audit event: `POD Milestone Updated` (previous value, new value) — only when the derived value actually changes |

**System Validations:** `Load.pod_status` is never directly settable by a user — it is always recalculated from underlying Stop-level document data.

**Audit Events:** `POD Milestone Updated` (system-generated, only on actual change)

**Completion Criteria:** `Load.pod_status` always accurately reflects current per-stop POD documentation.

---

## 7.3 Multiple / Replacement PODs

**Trigger:** A better-quality scan arrives, or a second document is needed for the same stop (e.g., separate signed BOL-style POD pages)

| Step | Uploading User | System |
|---|---|---|
| 1 | Uploads an additional POD file for the same delivery Stop | — |
| 2 | — | Creates a new `Document` version (per the general Document versioning rules established in the PRD) rather than discarding the prior one; sets new version as current |
| 3 | — | Writes audit event: `POD Document Version Added` |
| 4 | — | Re-derives `Load.pod_status` (unaffected in this case, since the stop already had a POD — status was already counted) |

**Completion Criteria:** All historical POD versions for a stop remain accessible; the current version is clearly indicated, consistent with general Document Center behavior.

---

## 7.4 Timing Independence

POD upload is explicitly decoupled from the Load's primary status progression:
- Can occur **before** `DELIVERED` (e.g., a POD arrives unusually early for a completed stop while other stops are still in transit).
- Can occur **at** `DELIVERED`.
- Can occur **after** the Load has advanced into any downstream status (e.g., `CUSTOMER_INVOICED`, `CARRIER_PAY`, or even `CLOSED`) — since the PRD establishes POD as a soft warning, not a hard gate, at every downstream step, uploading one late never blocks or reopens those later statuses.

**Completion Criteria:** N/A as a standalone gate — this is a standing rule governing 7.1 and 7.2 at any point in a Load's lifecycle.

---

## 7.5 No Approval, No Notifications (explicit scope boundary)

- **No reviewer/approval workflow** applies to POD documents in V1 — this deliberately differs from the Carrier compliance document review process in Workflow 3.
- **No notifications** are generated on POD upload or milestone change in V1. Downstream consumers (e.g., Accounting during invoicing) read `Load.pod_status` directly when needed, rather than being pushed a notification.

---

## 7.6 Handoff to Workflow 8

Workflow 7 ends once POD documentation is recorded and `Load.pod_status` is current. The **behavior** of warning a user who attempts to invoice a Load without `pod_status = COMPLETE` is defined and enforced in **Workflow 8 (Customer Invoicing)** — this workflow only produces the underlying data (documents + derived milestone) that Workflow 8 will read.

---

## Cross-Cutting: Permissions
- POD upload: Admin, Operations Manager, Dispatcher, Accounting.
- No separate approval permission exists for PODs (unlike carrier compliance documents).

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `POD Uploaded` | Uploading User |
| `POD Document Version Added` | Uploading User |
| `POD Milestone Updated` | System (automatic, only on change) |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| POD uploaded to a Load with no delivery stops defined | Blocked — a delivery Stop must exist to associate the POD with |
| POD uploaded before `DELIVERED` | Allowed — no status restriction |
| POD uploaded after downstream statuses (Invoiced, Carrier Paid, Closed) | Allowed — never blocks or reopens later steps |
| Attempt to directly set `Load.pod_status` | Not possible — always system-derived from Stop-level documents |

---

*Locked as part of Stage 2 — Business Workflows. Defines per-delivery-stop POD upload with no approval gate and no notifications, a system-derived load-level `pod_status` milestone (Not Received / Partial / Complete) independent of the primary Load status, document versioning for replacement PODs, and unrestricted upload timing relative to the Load's lifecycle. The missing-POD warning at invoicing time is defined in Workflow 8.*
