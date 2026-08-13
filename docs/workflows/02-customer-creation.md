# Workflow 2: Customer Creation
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md), [Workflow 1](01-organization-user-onboarding.md)

## Actors
| Actor | Description |
|---|---|
| **Creating User** | Admin, Sales/Booking, Operations Manager, or Accounting — any user with Customer-creation permission |
| **System** | The TMS application (validation, duplicate detection, defaults, audit logging) |

## Trigger
An authorized user initiates "Create Customer" — typically because a new prospective or confirmed shipper relationship needs to be recorded.

## Preconditions
- Acting user is Active and holds one of: Admin, Sales/Booking, Operations Manager, Accounting.
- Organization has a `default_payment_terms` value configured (set to Net 30 at provisioning — see Workflow 1, §1.1).

---

## 2.1 Customer Creation

| Step | User (Creating User) | System |
|---|---|---|
| 1 | Initiates "Create Customer" | — |
| 2 | Enters required fields: legal company name, billing address, primary contact name, primary contact email, primary contact phone | — |
| 3 | *(Optional)* Enters account owner, additional contacts, locations, rate agreement info, payment-term override | — |
| 4 | Submits form | Validates required fields present and well-formed |
| 5 | — | Confirms `Organization.default_payment_terms` is configured (see 2.3 for failure path) |
| 6 | — | Runs **duplicate detection** (see 2.2) |
| 7a | If no likely duplicate: — | Proceeds to save |
| 7b | If likely duplicate found: reviews potential match(es), chooses "Continue Anyway" or "Cancel" | Displays potential duplicate(s) with matching signals highlighted |
| 8 | — | Creates `Customer` record: status = `Prospect`, payment_terms = org's current `default_payment_terms` unless overridden, account_owner = as entered or null |
| 9 | — | Writes audit event: `Customer Created` |
| 10 | — | Displays newly created Customer record |

**Required Fields (must be present to save)**
- Legal company name
- Billing address
- Primary contact name
- Primary contact email
- Primary contact phone

**Optional Fields (may be added now or later)**
- Account owner (Sales/Account Manager)
- Additional contacts (with roles)
- Customer locations
- Rate agreements
- Payment terms override (defaults to org setting if omitted)
- Notes, other business information

**System Validations**
- All required fields present and non-empty.
- Primary contact email is a valid email format.
- Billing address contains minimum structured components (street, city, state, ZIP).
- Creating user's role is one of: Admin, Sales/Booking, Operations Manager, Accounting.
- Organization has a valid `default_payment_terms` configured (hard precondition — see 2.3).

**Status Assignment**
- New Customer always starts at status = `Prospect`, regardless of who creates it or how complete the record is.
- The system prevents booking a load against a Customer while status is `Prospect`, `Inactive`, or `Blocked`. (Enforcement occurs in the future Quote/Load creation workflow, not here — noted as a dependency.)

**Account Ownership**
- Account owner is optional at creation. If left blank, the Customer has no assigned owner and can be assigned later by any authorized user.

**Payment-Term Inheritance**
- If no override is provided, `Customer.payment_terms` = `Organization.default_payment_terms` **as of the moment of creation** (Net 30 unless the org has since changed its default via a future Organization Settings workflow).
- If an override is provided, `Customer.payment_terms` = the override value.
- A customer's payment terms (inherited or overridden) are independent once set: a later change to the organization's default does **not** retroactively change any existing customer's terms.

**Data Created**
- `Customer` record: organization_id, legal_name, billing_address, primary_contact (name/email/phone), status = Prospect, account_owner (nullable), payment_terms, created_by, created_at.

**Documents Generated:** None
**Notifications:** None specified for creation itself
**Audit Events:** `Customer Created` (actor: Creating User, entity: Customer, captured field values at creation)

**Completion Criteria:** `Customer` record exists with status `Prospect`, all required fields populated, payment terms set (inherited or overridden), and is visible/searchable to authorized users in the organization.

---

## 2.2 Duplicate Detection (sub-process, occurs within Step 6 above)

**Trigger:** Form submitted with required fields valid
**Matching Signals**
- Legal company name (fuzzy/normalized match — case-insensitive, punctuation-insensitive)
- Billing address (normalized match on street/city/state/ZIP)
- Primary contact email (exact match against another customer's primary or additional contacts)

| Step | User | System |
|---|---|---|
| 1 | — | Searches existing Customers in the organization for matches on the signals above |
| 2 | — | If one or more likely matches found, halts save and presents a **Possible Duplicate** warning listing matched Customer(s) with the matching field(s) highlighted |
| 3 | Reviews match(es); chooses **"View Existing Customer"**, **"Continue Anyway — Create New"**, or **"Cancel"** | — |
| 4a | Selects "Continue Anyway" | Proceeds with save (Step 8 in 2.1); writes audit event `Duplicate Warning Acknowledged` with the matched Customer ID(s) noted |
| 4b | Selects "View Existing Customer" | Navigates to the existing record; new-customer creation is abandoned (not saved) |
| 4c | Selects "Cancel" | Returns to the form without saving |

**Nature of Check:** Warning only — never a hard block. Authorized user retains final judgment.

**Audit Events**
- `Duplicate Warning Shown` (system-generated, records matched candidate(s))
- `Duplicate Warning Acknowledged` (actor: Creating User, if they proceed anyway)

**Completion Criteria:** User has either been warned and explicitly proceeded, or abandoned/redirected — no Customer is silently created without the check running.

---

## 2.3 Exception: Missing Organization Payment-Terms Configuration

**Trigger:** Organization Creation (Workflow 1) did not result in a valid `default_payment_terms` value being set — a data/configuration problem, not an expected state.

| Step | User (Creating User) | System |
|---|---|---|
| 1 | Submits Customer creation form | Detects `Organization.default_payment_terms` is missing/invalid |
| 2 | — | **Blocks** Customer creation entirely; does not fall back to a silently chosen default |
| 3 | Sees a clear configuration error (e.g., *"Your organization is missing a default payment terms setting. Contact your Administrator or support."*) | Writes audit event `Customer Creation Blocked — Missing Organization Configuration` |

**Completion Criteria:** No Customer record is created while this condition exists. Resolution requires the organization's payment-terms configuration to be corrected (handled by a future Organization Settings workflow), not by this workflow silently guessing a value.

---

## 2.4 Status Progression: Prospect → Active (referenced, not fully specified here)

This workflow creates the Customer at `Prospect`. Moving a Customer to `Active` is a separate status-change action, available to authorized users at any point after creation — not part of the creation transaction. Full detail (who can change it, whether any checklist applies) belongs to a future workflow (likely Customer Lifecycle Management, or the Quote/Booking workflow where the Active requirement is enforced).

**Enforcement point:** the system prevents booking a load against a Customer whose status is `Prospect`, `Inactive`, or `Blocked` — enforced in the future Load/Quote creation workflow, not this one.

---

## 2.5 Editing After Creation (cross-reference)

Customer master data (legal name, billing address, contacts, payment terms, etc.) remains editable at any time after creation by authorized users. Key rules:

- Edits to a Customer record **do not retroactively alter** historical transactions (invoices, loads, rate agreements already applied). Those records snapshot the relevant Customer values (e.g., billing address and payment terms **as of invoice creation**) rather than referencing the live Customer record.
- Every edit to a Customer record is captured in the audit trail: field changed, previous value, new value, user, timestamp.
- This workflow does not define the edit UI itself — only establishes that creation-time values are the first entry in that audit history.

---

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Customer Created` | Creating User |
| `Duplicate Warning Shown` | System (automatic) |
| `Duplicate Warning Acknowledged` | Creating User (only if proceeding past a warning) |
| `Customer Creation Blocked — Missing Organization Configuration` | System (automatic, exception path) |

---

## Exception Paths Summary
| Exception | Handling |
|---|---|
| Required field missing/invalid | Submission blocked, field-level errors shown, no record created |
| Likely duplicate found | Warning shown; user chooses to view existing, continue anyway, or cancel |
| User lacks permission | "Create Customer" action not available / blocked with permission error |
| Organization missing `default_payment_terms` | Hard block with configuration error (see 2.3) — no silent default chosen |

---

*Locked as part of Stage 2 — Business Workflows. Defines manual, one-at-a-time Customer creation, required vs. optional fields, Prospect default status, duplicate detection (warning-only), payment-term inheritance, and the missing-configuration exception path. Bulk Customer import is explicitly out of scope — a separate future workflow. Organization-level settings beyond default payment terms (numbering formats, etc.) belong to a future Organization Settings workflow.*
