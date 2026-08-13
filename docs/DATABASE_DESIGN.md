# Stage 4: Database Design
**Status:** 🔒 COMPLETE — all 15 Decision Log items locked. Ready for Stage 5 (UI/UX Design); migrations remain a Stage 7 activity.
**Source of truth:** [docs/PRD.md](PRD.md), [docs/workflows/](workflows/) (Workflows 1–10), [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/architecture-decisions.md](architecture-decisions.md) (all 12 decisions locked)
**Scope:** Logical entity/table design — fields, types, relationships, constraints, indexes. **No physical migrations or application code are written here.**

## How to read this document
Types shown (e.g., `UUID`, `DECIMAL(12,2)`, `TIMESTAMP`, `JSONB`) are logical/Postgres-flavored per the locked technology stack (Decision 12), used to make the design concrete — but this is still a design document, not a migration script. Every table is implicitly `organization_id`-scoped and RLS-protected (§14) unless explicitly noted as global (only `User` and `Organization` itself).

---

## 1. Multi-Tenant Structure Overview

Per Architecture Decision 4 (RLS as defense-in-depth) and Decision 1 (global User + membership), the schema has exactly **two tables with no `organization_id`**: `User` (global identity) and `Organization` (the tenant root itself). Every other table carries `organization_id` directly — including child/detail tables (Stop, ChargeLineItem, Payment, etc.) — per the denormalization convention locked in Decision Log item D2 (§16). This keeps every RLS policy a simple, fast equality check with no join required.

```
Organization (tenant root)
  └── OrganizationMembership ← User (global)
  └── everything else, all carrying organization_id directly
```

---

## 2. Identity: Global Users & Organization Memberships

### `User` (global — no `organization_id`)
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| email | VARCHAR, UNIQUE | Global login identity (Architecture Decision 1) |
| password_hash | VARCHAR | bcrypt/argon2 |
| name | VARCHAR | |
| is_platform_super_admin | BOOLEAN, default false | Platform-level flag; no membership implied |
| status | ENUM(`PENDING_VERIFICATION`,`ACTIVE`,`SUSPENDED`) | Global account status, distinct from per-org membership status |
| email_verified_at | TIMESTAMP, nullable | |
| created_at | TIMESTAMP | |

### `OrganizationMembership`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| user_id | UUID FK → User | |
| status | ENUM(`PENDING_VERIFICATION`,`INVITED`,`ACTIVE`,`INACTIVE`,`EXPIRED`,`CANCELLED`) | Per Workflow 1; `PENDING_VERIFICATION` only applies to a brand-new global User's first-ever membership |
| invited_by_user_id | UUID FK → User, nullable | Null for the system-created initial Admin membership |
| invited_at | TIMESTAMP, nullable | |
| invitation_token_hash | VARCHAR, nullable | Never store plaintext |
| invitation_expires_at | TIMESTAMP, nullable | 7-day rule (Workflow 1 §1.4) |
| activated_at | TIMESTAMP, nullable | |
| deactivated_at | TIMESTAMP, nullable | |
| deactivated_by_user_id | UUID FK → User, nullable | |
| created_at | TIMESTAMP | |

`UNIQUE (organization_id, user_id)` — one membership per person per org.

### `MembershipRole`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | Denormalized for RLS (§1) |
| membership_id | UUID FK → OrganizationMembership | |
| role | ENUM(`ADMIN`,`OPERATIONS_MANAGER`,`DISPATCHER`,`SALES_BOOKING`,`ACCOUNTING`,`COMPLIANCE_REVIEWER`) | Multi-role per membership (Workflow 1 §7) |

`UNIQUE (membership_id, role)` — no duplicate role assignment.

**Zero-Admin protection (Workflow 1 §1.7):** enforced at the application layer by counting `MembershipRole` rows with `role = ADMIN` joined to `ACTIVE` memberships in the target organization — not a DB constraint (the rule is conditional on the specific membership being deactivated, which a CHECK constraint can't express).

---

## 3. Organizations & Numbering Sequences

### `Organization`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| legal_name | VARCHAR | |
| address_line1/city/state/zip/country | VARCHAR | |
| primary_contact_name/email/phone | VARCHAR | |
| default_payment_terms | ENUM(`DUE_ON_RECEIPT`,`NET_15`,`NET_30`,`NET_45`,`NET_60`) | Set to `NET_30` at provisioning (Workflow 1 §1.1) |
| status | ENUM(`ACTIVE`,`SUSPENDED`) | Platform-level org status |
| created_by_user_id | UUID FK → User | The Platform Super Admin who provisioned it |
| created_at | TIMESTAMP | |

### `OrganizationSequence`
Per Decision Log item D3 (§16) — a dedicated counter table rather than native Postgres sequences per org, since sequence *types* are fixed (Load/Quote/Invoice) but there are many organizations.
| Field | Type | Notes |
|---|---|---|
| organization_id | UUID FK → Organization | |
| sequence_type | ENUM(`LOAD`,`QUOTE`,`INVOICE`) | |
| current_value | BIGINT, default 0 | Incremented via `SELECT ... FOR UPDATE` inside the creating transaction |

`PRIMARY KEY (organization_id, sequence_type)`. Formatted at the application layer into `LOAD-000456`, `QUOTE-000123`, `INV-000001` (PRD-locked formats).

---

## 4. Customers

### `Customer`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| legal_name | VARCHAR | |
| billing_address_line1/city/state/zip/country | VARCHAR | |
| primary_contact_name/email/phone | VARCHAR | |
| status | ENUM(`PROSPECT`,`ACTIVE`,`INACTIVE`,`BLOCKED`) | Default `PROSPECT` (Workflow 2 §2.1) |
| account_owner_user_id | UUID FK → User, nullable | |
| payment_terms | ENUM (same as Organization) | Inherited at creation, independently overridable (Workflow 2 §2.1) |
| payment_terms_source | ENUM(`INHERITED`,`OVERRIDE`) | |
| created_by_user_id | UUID FK → User | |
| created_at / updated_at | TIMESTAMP | |

### `CustomerContact`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| customer_id | UUID FK → Customer | |
| name / email / phone | VARCHAR | |
| role | ENUM(`BOOKING`,`OPERATIONS`,`BILLING`,`MANAGEMENT`,`OTHER`) | |
| is_primary | BOOLEAN | |

### `CustomerLocation`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| customer_id | UUID FK → Customer | |
| name | VARCHAR | |
| address_line1/city/state/zip/country | VARCHAR | |
| location_type | ENUM(`PICKUP`,`DELIVERY`,`OTHER`) | |
| contact_name/phone/email | VARCHAR, nullable | |
| operating_hours | TEXT | |
| appointment_requirements | TEXT | |
| notes | TEXT | |

### `CustomerRateAgreement`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| customer_id | UUID FK → Customer | |
| origin_city/state | VARCHAR | Per Decision Log D12 — inline structured fields, not a shared Address entity |
| destination_city/state | VARCHAR | |
| equipment_type | ENUM(`DRY_VAN`,`REEFER`,`FLATBED`) | |
| rate | DECIMAL(12,2) | |
| rate_type | VARCHAR | e.g., flat, per-mile — free-form per PRD's "basic functionality first" |
| effective_date / expiration_date | DATE | |
| fuel_surcharge_rules | TEXT | |
| notes | TEXT | |

---

## 5. Carriers

### `Carrier`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| legal_name | VARCHAR | |
| dba | VARCHAR, nullable | |
| mc_number / dot_number | VARCHAR | |
| address_line1/city/state/zip | VARCHAR | |
| primary_contact_name/phone/email | VARCHAR | |
| status | ENUM(`PENDING`,`ACTIVE`,`INACTIVE`,`BLOCKED`) | Default `PENDING` (Workflow 3 §3.1) |
| assignment_eligible | BOOLEAN | **Persisted derived field** (Architecture §11, Decision 5) |
| ineligibility_reasons | JSONB, nullable | Array of reason strings, recalculated alongside `assignment_eligible` |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

`UNIQUE (organization_id, mc_number)`, `UNIQUE (organization_id, dot_number)` — hard block per Workflow 3 §3.2.

### `CarrierContact`
Same shape as `CustomerContact`, roles = `DISPATCH`,`SAFETY_COMPLIANCE`,`BILLING`,`FACTORING`,`MANAGEMENT`,`OTHER`.

### `CarrierInsurance`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| carrier_id | UUID FK → Carrier | |
| coverage_type | ENUM(`AUTO_LIABILITY`,`CARGO`) | Both required for eligibility (Workflow 3 §3.6) |
| coverage_amount | DECIMAL(12,2) | |
| insurance_company | VARCHAR | |
| agent_contact | VARCHAR | |
| effective_date / expiration_date | DATE | **Source of truth for expiration** (Workflow 3 §3.9 clarification — not inferred from the COI file) |
| coi_document_id | UUID FK → Document | The supporting COI file (§6) |

### `CarrierFmcsaVerification`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| carrier_id | UUID FK → Carrier | |
| verification_date | DATE | |
| result_status | VARCHAR | e.g., Authorized, Not Authorized, Out of Service |
| verified_by_user_id | UUID FK → User | |
| authority_info | TEXT | |
| notes | TEXT | |

### `CarrierServiceArea` — Lane / Region Preferences
**Schema addendum, added during Stage 5** (Carrier Detail screen design surfaced that PRD §Carriers and Workflow 3 §3.6 both describe trackable "preferred lanes, regions, or service areas," but no such field/table existed in the original Stage 4 pass — see Decision Log D16). Kept deliberately simple per PRD §3.6's explicit instruction: "keep this relatively simple and searchable/filterable rather than building a sophisticated matching engine" — this is pure storage/display data with no eligibility impact and no automated lane-matching logic.

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | Denormalized per the RLS convention (§1, Decision Log D2) |
| carrier_id | UUID FK → Carrier | |
| type | ENUM(`LANE`,`REGION`) | |
| origin_city / origin_state | VARCHAR, nullable | Populated when `type = LANE` |
| destination_city / destination_state | VARCHAR, nullable | Populated when `type = LANE` |
| region_label | VARCHAR, nullable | Free-text (e.g., "Southeast US," "West Coast") — populated when `type = REGION` |
| notes | TEXT, nullable | |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

**Application-layer validation** (not a DB constraint, consistent with how state-machine transitions are validated elsewhere in this design, §13): a `LANE` row should have at least `origin_state` and `destination_state` populated; a `REGION` row should have `region_label` populated. No matching/scoring logic — this is searchable/filterable tag-like data only (e.g., "show carriers with a preference tagged Texas → California"), exactly matching the PRD's explicit scope limit. No new carrier business rule is introduced — this table has no bearing on `assignment_eligible` (Workflow 3 §3.8's 7 conditions are unchanged) or any other locked workflow gate.

### `CarrierFactoringInfo`
| Field | Type | Notes |
|---|---|---|
| carrier_id | UUID FK → Carrier, PK | 1:1 with Carrier |
| organization_id | UUID FK → Organization | |
| uses_factoring | BOOLEAN | |
| factoring_company | VARCHAR, nullable | |
| remit_to_address | TEXT, nullable | |
| factoring_contact | VARCHAR, nullable | |
| payment_instructions | TEXT, nullable | |
| noa_status | VARCHAR, nullable | |
| noa_document_id | UUID FK → Document, nullable | |
| updated_at | TIMESTAMP | |

Informational only — no eligibility linkage (Workflow 3 §3.11).

---

## 6. Drivers, Trucks, Trailers

All three are lightweight, carrier-linked, reusable records (Workflow 3, later selected/snapshotted at Dispatch per Workflow 6).

### `Driver`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| carrier_id | UUID FK → Carrier | |
| first_name / last_name | VARCHAR | |
| phone | VARCHAR | |
| email | VARCHAR, nullable | |
| license_number | VARCHAR, nullable | |
| notes | TEXT | |
| active | BOOLEAN | |

*(Future compliance fields — CDL class/expiration, medical card, HOS, ELD, drug/alcohol — explicitly NOT included in V1 schema; PRD §4 lists them as future-phase only, see §13.)*

### `Truck`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| carrier_id | UUID FK → Carrier | |
| unit_number | VARCHAR | |
| truck_type | ENUM(`DRY_VAN`,`REEFER`,`FLATBED`) | |
| make / model / year | VARCHAR/INT, nullable | |
| vin / plate | VARCHAR, nullable | |
| active | BOOLEAN | |
| notes | TEXT | |

### `Trailer`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| carrier_id | UUID FK → Carrier | |
| unit_number | VARCHAR | |
| trailer_type | ENUM(`DRY_VAN`,`REEFER`,`FLATBED`) | |
| vin / plate | VARCHAR, nullable | |
| active | BOOLEAN | |
| notes | TEXT | |

---

## 7. Documents (Universal, Polymorphic, Versioned)

Per Architecture Decision 3 (generic polymorphic columns) and Decision 10 (mandatory malware scanning).

### `Document`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| document_family_id | UUID | Stable ID shared by every version of "the same document" (Decision Log D4) |
| entity_type | ENUM(`LOAD`,`STOP`,`CUSTOMER`,`CARRIER`,`DRIVER`,`TRUCK`,`TRAILER`,`INVOICE`,`CARRIER_PAYMENT`) | |
| entity_id | UUID | Application-layer-validated (no native FK across polymorphic types) |
| document_type_id | UUID FK → DocumentTypeDefinition | See below (Decision Log D13) |
| custom_type_label | VARCHAR, nullable | Only used if `document_type_id` points to a generic "custom" definition |
| file_storage_key | VARCHAR | `org_{organization_id}/documents/{uuid}` convention (Architecture Decision 9) |
| file_name | VARCHAR | Original filename, display-only, never used as storage path |
| file_size_bytes | BIGINT | |
| mime_type | VARCHAR | Restricted to PDF/JPG/JPEG/PNG in V1 |
| version_number | INT | |
| is_current_version | BOOLEAN | Exactly one `TRUE` per `document_family_id` |
| scan_status | ENUM(`PENDING`,`CLEAN`,`INFECTED`,`SCAN_FAILED`) | Gates download (Architecture Decision 10) |
| scanned_at | TIMESTAMP, nullable | |
| scan_provider | VARCHAR, nullable | Traceability only — no provider-specific data stored |
| review_status | ENUM(`NOT_APPLICABLE`,`PENDING_REVIEW`,`APPROVED`,`REJECTED`,`EXPIRED`), nullable | Only meaningful for carrier compliance doc types; `NOT_APPLICABLE` for POD/other non-reviewed types |
| reviewed_by_user_id | UUID FK → User, nullable | |
| reviewed_at | TIMESTAMP, nullable | |
| rejection_reason | TEXT, nullable | |
| expiration_date | DATE, nullable | Only for document types that carry one (e.g., MC Authority); insurance expiration lives on `CarrierInsurance`, not here (Workflow 3 clarification) |
| uploaded_by_user_id | UUID FK → User | |
| uploaded_at | TIMESTAMP | |

**Self-review prevention** (Workflow 3 §3.4): enforced at the application layer — `reviewed_by_user_id ≠ uploaded_by_user_id` is checked in the service method, not a DB constraint (a CHECK constraint can't easily express "compare to the value at time of a different row's insert").

**Settlement documents** (Workflow 9 §9.8) and **Rate Confirmations** (Workflow 5 §5.7) are just `Document` rows with `entity_type = CARRIER_PAYMENT` / `LOAD` and the appropriate `document_type_id` — no separate tables (Decision Log D6).

### `DocumentTypeDefinition`
Per Decision Log D13 — a lookup table (not a fixed enum) because the PRD requires org-level custom document types.
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization, nullable | NULL = system-provided default type, available to all orgs |
| category | ENUM(`LOAD`,`CARRIER_COMPLIANCE`) | Matches the two groupings in PRD §9 |
| code | VARCHAR | e.g., `RATE_CONFIRMATION`, `BOL`, `POD`, `W9`, `COI`, `CARRIER_AGREEMENT`, `MC_AUTHORITY`, `FACTORING_NOA`, `CUSTOM` |
| label | VARCHAR | Display name |
| requires_review | BOOLEAN | True for the 4 compliance types (Workflow 3 §3.6); false for POD, etc. |
| is_system_default | BOOLEAN | |

System-default rows (W9, COI, Carrier Agreement, MC Authority, Rate Confirmation, BOL, POD, Lumper Receipt, Scale Ticket, Accessorial Receipt, Delivery/Damage Photo, Factoring NOA, Settlement) are seeded at deploy time; organizations may add their own additional rows.

---

## 8. Quotes & Quote Stops

### `Quote`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| quote_number | VARCHAR | `QUOTE-000123`, from `OrganizationSequence` |
| customer_id | UUID FK → Customer | |
| equipment_type | ENUM(`DRY_VAN`,`REEFER`,`FLATBED`) | |
| customer_rate | DECIMAL(12,2) | |
| rate_source | ENUM(`MANUAL`,`RATE_AGREEMENT`,`MANUAL_OVERRIDE`) | Workflow 4 §4.4 |
| rate_agreement_id | UUID FK → CustomerRateAgreement, nullable | **Retained even on override** (Workflow 4 locked decision) |
| status | ENUM(`OPEN`,`WON`,`LOST`) | Both terminal states permanent — no reopening (Workflow 4 §4.6) |
| loss_reason | TEXT, nullable | |
| expiration_date | DATE | Default now + 7 days |
| resulting_load_id | UUID FK → Load, nullable | Set on conversion |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

`UNIQUE (organization_id, quote_number)`.

### `QuoteStop`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| quote_id | UUID FK → Quote | |
| sequence | INT | |
| stop_type | ENUM(`PICKUP`,`DELIVERY`) | |
| address_city/state/zip | VARCHAR | |
| appointment_notes | TEXT | Quotes need only lane-level info, not full appointment detail (Workflow 4 §4.2) |

---

## 9. Loads & Stops

### `Load`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_number | VARCHAR | `LOAD-000456`, generated only at BOOKED (Workflow 4 §4.9) |
| customer_id | UUID FK → Customer | |
| booking_source | ENUM(`QUOTE`,`DIRECT`) | Workflow 4 locked decision |
| quote_id | UUID FK → Quote, nullable | Set only if `booking_source = QUOTE` |
| status | ENUM(`BOOKED`,`CARRIER_SOURCING`,`CARRIER_ASSIGNED`,`RATE_CONFIRMATION`,`DISPATCHED`,`PICKUP`,`IN_TRANSIT`,`DELIVERED`,`CLOSED`) | Full state machine, Workflows 4–6, 10 |
| equipment_type | ENUM(`DRY_VAN`,`REEFER`,`FLATBED`) | |
| customer_rate | DECIMAL(12,2) | Original agreed rate — never overwritten (PRD §5.2) |
| rate_source | ENUM(`MANUAL`,`RATE_AGREEMENT`,`MANUAL_OVERRIDE`) | |
| rate_agreement_id | UUID FK → CustomerRateAgreement, nullable | |
| customer_po_number / bol_number / pickup_number / customer_reference_number | VARCHAR, nullable | Optional, addable any time (Workflow 4 §4.10) |
| assigned_carrier_id | UUID FK → Carrier, nullable | Cleared on rejection (Workflow 5 §5.6) |
| carrier_rate | DECIMAL(12,2), nullable | |
| assigned_dispatcher_id | UUID FK → User, nullable | Independent action (Workflow 4 §4.11 / Workflow 1 pattern) |
| pod_status | ENUM(`NOT_RECEIVED`,`PARTIAL`,`COMPLETE`) | **Persisted derived field** (Workflow 7 §7.2) |
| risk_status | ENUM(`NORMAL`,`AT_RISK`,`DELAYED`) | Independent of `status` (Workflow 6 §6.8) |
| risk_reason | VARCHAR, nullable | |
| current_location_city/state/zip | VARCHAR, nullable | |
| current_location_description | TEXT, nullable | |
| current_location_updated_at | TIMESTAMP, nullable | |
| current_eta | TIMESTAMP, nullable | |
| invoiced | BOOLEAN, default false | Prevents double-billing (Workflow 8 §8.1) |
| posted_externally / posting_platform / posting_status / posting_notes | mixed, nullable | External load-board placeholder (PRD §6.3.9) |
| closed_at | TIMESTAMP, nullable | |
| closed_by_user_id | UUID FK → User, nullable | |
| created_by_user_id | UUID FK → User | |
| created_at / updated_at | TIMESTAMP | |

`UNIQUE (organization_id, load_number)`.

### `Stop`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| sequence | INT | |
| stop_type | ENUM(`PICKUP`,`DELIVERY`,`OTHER`) | |
| customer_location_id | UUID FK → CustomerLocation, nullable | If reused from the customer's saved locations |
| address_line1/city/state/zip | VARCHAR | Inline, even if copied from a `CustomerLocation` — snapshot at time of booking |
| appointment_datetime | TIMESTAMP, nullable | |
| actual_arrival / actual_departure | TIMESTAMP, nullable | Both required for `COMPLETED` (Workflow 6 §6.5) |
| status | ENUM(`PENDING`,`ARRIVED`,`COMPLETED`) | |
| contact_name / contact_phone | VARCHAR, nullable | |
| notes | TEXT | |

---

## 10. Carrier Sourcing History

### `CarrierSourcingAttempt`
Per Workflow 5 §5.5/§5.6 — every attempt (assigned, declined, no-response, quoted, rejected-after-assignment) is its own permanent row, never overwritten.
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| carrier_id | UUID FK → Carrier | |
| carrier_rate | DECIMAL(12,2), nullable | |
| outcome | ENUM(`ASSIGNED`,`DECLINED`,`NO_RESPONSE`,`QUOTED`,`REJECTED_AFTER_ASSIGNMENT`) | |
| rejection_reason | TEXT, nullable | |
| logged_by_user_id | UUID FK → User | |
| logged_at | TIMESTAMP | |

---

## 11. Dispatch Records & History

### `DispatchRecord`
Per Decision Log D8 — **mutable, current-state only**; history lives in `AuditLog`, matching Workflow 6 §6.9's explicit language ("not a separate versioned table — the audit log itself is the historical record").
| Field | Type | Notes |
|---|---|---|
| load_id | UUID FK → Load, PK | 1:1 with Load |
| organization_id | UUID FK → Organization | |
| driver_name / driver_phone | VARCHAR | Snapshotted values (Workflow 6 §6.2) |
| truck_number / trailer_number | VARCHAR | |
| source_driver_id | UUID FK → Driver, nullable | |
| source_truck_id | UUID FK → Truck, nullable | |
| source_trailer_id | UUID FK → Trailer, nullable | |
| dispatched_by_user_id | UUID FK → User | |
| dispatched_at | TIMESTAMP | |
| updated_at | TIMESTAMP | Bumped on post-dispatch edits; old values captured via `AuditLog` |

---

## 12. Check Calls & Risk Tracking

### `CheckCall`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| logged_by_user_id | UUID FK → User | |
| occurred_at | TIMESTAMP | |
| contact_method | VARCHAR | |
| person_contacted | VARCHAR | |
| location_city / location_state / location_zip | VARCHAR, nullable | |
| eta | TIMESTAMP, nullable | |
| on_time_status | ENUM(`ON_TIME`,`LATE`,`UNKNOWN`) | |
| notes | TEXT | |

`Load.risk_status`/`risk_reason` live directly on `Load` (§9) rather than a separate table, since it's a single current value, not a history — changes are captured via `AuditLog`.

---

## 13. Load State-Machine Persistence

No separate "state machine" table — every state machine locked in Stage 2 is persisted as a single ENUM status column on its owning entity (`Load.status`, `Stop.status`, `Quote.status`, `Document.review_status`, `CarrierPayment.status`, `Invoice.status`), with legal-transition validation enforced entirely at the **application/domain layer** (Architecture §7), not via database CHECK constraints or triggers — Postgres CHECK constraints can express "status is one of these values" but not "this transition from X to Y is legal given these preconditions," which is genuinely business logic.

---

## 14. Charge Line Items

### `ChargeLineItem`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| side | ENUM(`CUSTOMER`,`CARRIER`) | Independent revenue/cost line items (PRD §8) |
| charge_type_id | UUID FK → ChargeTypeDefinition | See below (Decision Log D13) |
| description | VARCHAR, nullable | |
| quantity | DECIMAL(10,2), default 1 | |
| unit_rate | DECIMAL(12,2) | |
| amount | DECIMAL(12,2) | |
| source | ENUM(`ORIGINAL`,`ADJUSTMENT`) | Original booking-time linehaul vs. later accessorial addition |
| notes | TEXT | |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

A `LINEHAUL` line item (side=CUSTOMER, amount=`Load.customer_rate`) and (side=CARRIER, amount=`Load.carrier_rate`) are created automatically at booking/assignment time, giving every load a complete itemized breakdown from day one, with accessorials addable afterward.

**Accessorial charge addition (Decision Log D9 — LOCKED):** Admin, Operations Manager, Dispatcher, or Accounting may add a `ChargeLineItem` (`source = ADJUSTMENT`) to a Load at any time after booking. No approval workflow is required — consistent with the low-ceremony pattern used elsewhere for operational data (e.g., Internal Notes, Communication Activity). Every addition is fully captured in `AuditLog` (actor, amount, charge type, timestamp). Sales/Booking is excluded, matching its exclusion from carrier-sourcing and dispatch actions elsewhere. This is a business-rule decision, not just a schema choice — it fills the gap Stage 2 left open, without altering any already-locked workflow.

### `ChargeTypeDefinition`
Same lookup-table pattern as `DocumentTypeDefinition` (Decision Log D13), since accessorial types need org-level custom additions (PRD §8.2).
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization, nullable | NULL = system default |
| code | VARCHAR | `LINEHAUL`,`FUEL_SURCHARGE`,`DETENTION`,`LUMPER`,`LAYOVER`,`TONU`,`ADDITIONAL_STOP`,`REDELIVERY`,`OTHER`,`CUSTOM` |
| label | VARCHAR | |
| is_system_default | BOOLEAN | |

---

## 15. Invoices & Consolidated Invoicing

### `Invoice`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| invoice_number | VARCHAR | `INV-000001`, generated at Draft creation (Workflow 8 §8.7) |
| customer_id | UUID FK → Customer | |
| status | ENUM(`DRAFT`,`SENT`,`PARTIALLY_PAID`,`PAID`,`VOID`,`CREDITED`) | `OVERDUE` is **not** a stored value — computed at read time (Decision 5) |
| sent_at | TIMESTAMP, nullable | |
| due_date | DATE, nullable | Calculated at Send = `sent_at` + `Customer.payment_terms` (Workflow 8 §8.8) |
| total | DECIMAL(12,2) | Recalculated/persisted on every line-item/payment/adjustment change (Architecture §10) |
| remaining_balance | DECIMAL(12,2) | Same |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

`UNIQUE (organization_id, invoice_number)`.

**Computed `OVERDUE`:** application/query layer treats an invoice as Overdue when `status IN (SENT, PARTIALLY_PAID) AND due_date < CURRENT_DATE AND remaining_balance > 0` — never written to the `status` column itself, consistent with Workflow 8 §8.10's explicit "no scheduled recalculation job."

### `InvoiceLoad` (join — supports consolidated invoicing)
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| invoice_id | UUID FK → Invoice | |
| load_id | UUID FK → Load | |
| load_total_at_invoice | DECIMAL(12,2) | Snapshot of that load's total customer charges at invoicing time (Workflow 8 §8.5) |

`UNIQUE (load_id)` across all *non-void* invoices — enforces one-invoice-per-load at the database level, not just application logic (a load appears in at most one active `InvoiceLoad` row; a Void invoice's rows don't count, per Workflow 8 §8.12's "released back to Ready to Invoice queue" rule — enforced via a partial unique index excluding voided invoices, a Stage 7 implementation detail noted here for awareness).

### `InvoiceLineItem`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| invoice_id | UUID FK → Invoice | |
| description | VARCHAR | |
| amount | DECIMAL(12,2) | |
| source_load_id | UUID FK → Load, nullable | |
| source_charge_line_item_id | UUID FK → ChargeLineItem, nullable | Individual invoices: 1:1 copy per `ChargeLineItem` (Decision Log D11 — snapshotted, not referenced live) |

Per Workflow 8 §8.5: **individual** invoices get one `InvoiceLineItem` per underlying `ChargeLineItem`; **consolidated** invoices get one `InvoiceLineItem` per `Load` (summary total), with full detail remaining queryable via `ChargeLineItem` on the source Load.

---

## 16. Payments (Partial Support)

### `Payment`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| invoice_id | UUID FK → Invoice | |
| amount | DECIMAL(12,2) | |
| payment_date | DATE | |
| method | VARCHAR | |
| reference_number | VARCHAR, nullable | |
| notes | TEXT | |
| recorded_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

Multiple rows per invoice supported natively (Workflow 8 §8.9). Cannot be inserted against a `DRAFT` invoice — enforced at the application layer (status check), not a DB constraint, since it depends on a related row's current state.

---

## 17. Credit / Debit Adjustments

### `Adjustment`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| invoice_id | UUID FK → Invoice | |
| type | ENUM(`CREDIT`,`DEBIT`) | |
| amount | DECIMAL(12,2) | |
| reason | TEXT | Required, non-empty (Workflow 8 §8.11) |
| adjustment_date | DATE | |
| created_by_user_id | UUID FK → User | |
| created_at | TIMESTAMP | |

Never mutates `InvoiceLineItem` or the original `total` — only affects `remaining_balance` and derived status (financial integrity principle, PRD §8).

---

## 18. Carrier Payments & Allocation

### `CarrierPayment`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| carrier_id | UUID FK → Carrier | |
| amount | DECIMAL(12,2) | Locked at submission — not editable during approval (Workflow 9 §9.3) |
| payment_type | ENUM(`DEPOSIT`,`PARTIAL`,`BALANCE`,`ADJUSTMENT`) | |
| method | VARCHAR, nullable | |
| reference_number | VARCHAR, nullable | |
| notes | TEXT, nullable | |
| status | ENUM(`DRAFT`,`PENDING_APPROVAL`,`APPROVED`,`PAID`) | Rejection returns to `DRAFT`, not a separate `REJECTED` terminal state (Workflow 9 §9.5) |
| prepared_by_user_id | UUID FK → User | |
| submitted_at | TIMESTAMP, nullable | |
| approved_by_user_id | UUID FK → User, nullable | |
| approved_at | TIMESTAMP, nullable | |
| last_rejected_by_user_id | UUID FK → User, nullable | Most recent rejection only — full history via `AuditLog` |
| last_rejected_at | TIMESTAMP, nullable | |
| last_rejection_reason | TEXT, nullable | |
| paid_at | TIMESTAMP, nullable | |
| created_at | TIMESTAMP | |

**No line-item allocation** (Decision Log D10): a `CarrierPayment` is always against the load's overall carrier balance, not itemized to specific `ChargeLineItem` rows — Workflow 9 never specified per-charge allocation, so the simpler model is used.

**Self-approval prevention:** `approved_by_user_id ≠ prepared_by_user_id`, enforced at the application layer (same pattern as Document review, §7).

**Carrier balance** (`total_paid`, `remaining_carrier_balance`) is **computed at read time** by summing `PAID` `CarrierPayment` rows against `Load.carrier_rate` — not a stored column, since Workflow 9 §9.7 describes it as continuously computed rather than a field explicitly required to be persisted, and per-load payment counts are small enough that summing is cheap.

---

## 19. Settlement Documents

No dedicated table — a `Document` row (`entity_type = CARRIER_PAYMENT`, `document_type` = Settlement) generated automatically when a `CarrierPayment` transitions to `PAID` (Workflow 9 §9.8, Decision Log D6).

---

## 20. Profitability Model

Not a stored table — computed at read time (Architecture §10):
- **Per-load Gross Profit** = `SUM(ChargeLineItem.amount WHERE side=CUSTOMER) − SUM(ChargeLineItem.amount WHERE side=CARRIER)` for that `load_id`.
- **Margin %** = Gross Profit / Customer total.
- **Rollups** (by customer/carrier/lane/dispatcher/sales user/date/equipment) use SQL aggregation (`GROUP BY`) directly over `ChargeLineItem` joined to `Load`, per PRD §9's "generate reports from live transactional data" principle — no separate reporting/summary tables in V1.

---

## 21. AR / AP Aging Foundation

Also computed, not stored:
- **AR aging**: bucket `Invoice` rows (`SENT`/`PARTIALLY_PAID`/computed-`OVERDUE`) by `CURRENT_DATE − due_date` into Current/1-30/31-60/61-90/90+ (PRD §9).
- **AP aging (Decision Log D14 — LOCKED)**: bucket outstanding carrier balances (`Load.carrier_rate − SUM(PAID CarrierPayment.amount)`) by `CURRENT_DATE − CarrierPayment.submitted_at` (the date the payment obligation was formally submitted for approval; for a load with no `CarrierPayment` yet at all, the outstanding balance is not yet aged, since no obligation has been formally recorded). This anchor was chosen — rather than inventing a "carrier payment terms" concept analogous to `Customer.payment_terms` — specifically because no such concept exists anywhere in the locked PRD or workflows, and introducing one would be a new business rule, not a schema decision.

---

## 22. Load Closing & Checklist Snapshots

No dedicated `LoadClosingSnapshot` table (Decision Log D7) — the checklist state at the moment of closing (Rate Confirmation on file, `pod_status`, Invoice existence, Carrier Pay existence/balance) is captured as the `new_value` JSONB payload on the `Load Closed` `AuditLog` entry, consistent with how `DispatchRecord` history is handled (§11). `Load.closed_at`/`closed_by_user_id` (§9) mark the milestone itself.

---

## 23. Universal Audit Log

### `AuditLog`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| actor_user_id | UUID FK → User, nullable | Null only for `actor_type = SYSTEM` events with no human trigger |
| actor_type | ENUM(`HUMAN`,`SYSTEM`,`AI`) | Architecture Decision 8 — `AI` unused in V1, reserved |
| action | VARCHAR | e.g., `Carrier Assigned`, `Invoice Sent` — matches the ~60+ named events across Workflows 1–10 |
| entity_type | VARCHAR | |
| entity_id | UUID | |
| previous_value | JSONB, nullable | |
| new_value | JSONB, nullable | |
| reason | TEXT, nullable | |
| created_at | TIMESTAMP | |

Per Decision Log D15: `new_value`/`previous_value` follow a convention of **field-level diffs** for edits (`{"field_changes": [{"field": "status", "previous": "DRAFT", "new": "PENDING_APPROVAL"}]}`) and **full-entity snapshots** for creation/major-transition events (e.g., the Load Closing checklist snapshot, §22) — a single flexible JSONB shape accommodates both without a schema change.

**No per-entity audit tables** — this single table serves every workflow's audit requirements (Architecture §9).

---

## 24. Domain Events

### `DomainEvent`
Internal-only table (not user-facing) supporting the event-driven pattern from Architecture §9/§12/§13 — the shared mechanism `AuditLog` and `Notification` both consume, and the future foundation for webhooks.
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| event_type | VARCHAR | e.g., `LoadDispatched`, `InvoicePaid` |
| entity_type / entity_id | VARCHAR / UUID | |
| payload | JSONB | |
| actor_user_id | UUID FK → User, nullable | |
| actor_type | ENUM(`HUMAN`,`SYSTEM`,`AI`) | |
| occurred_at | TIMESTAMP | |

V1 subscribers: `AuditLog` writer, `Notification` writer (§25). No outbox/external delivery table needed yet (Architecture §13 — that's added when webhooks are actually built).

---

## 25. Notifications, Communication Activities & Internal Notes

### `Notification`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| recipient_user_id | UUID FK → User | |
| type | VARCHAR | e.g., `ComplianceExpiring30Day` |
| related_entity_type / related_entity_id | VARCHAR / UUID, nullable | |
| message | VARCHAR | |
| read | BOOLEAN, default false | |
| created_at | TIMESTAMP | |

In-app only in V1 (PRD §12). No delivery-channel table needed yet.

### `CommunicationActivity`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| activity_type | VARCHAR | e.g., "Called Carrier", "Sent Rate Confirmation" |
| user_id | UUID FK → User | |
| occurred_at | TIMESTAMP | |
| notes | TEXT | |
| related_carrier_id / related_customer_id / related_driver_id | UUID, nullable | |

### `InternalNote`
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → Organization | |
| load_id | UUID FK → Load | |
| author_user_id | UUID FK → User | |
| content | TEXT | |
| created_at | TIMESTAMP | |

---

## 26. PostgreSQL Row-Level Security / Tenant Isolation

Per Architecture Decision 4:
- Every table above except `User` and `Organization` carries `organization_id` directly (including child tables — Decision Log D2).
- An RLS policy is defined per table: `USING (organization_id = current_setting('app.current_org_id')::uuid)`.
- The application sets `app.current_org_id` at the start of every request/transaction from the **validated current `OrganizationMembership`** — never from unvalidated client input (Architecture §2, Decision 1).
- `User` has no RLS policy (global table); access to another organization's `User` rows is prevented by application-layer query scoping only (e.g., a membership list query joins `OrganizationMembership` first, which *is* RLS-protected).
- `Organization` itself has no RLS policy in the conventional sense — a user's ability to see an `Organization` row is gated by having an `OrganizationMembership` into it, enforced at the application layer.

---

## 27. Indexes & Uniqueness Constraints (Key Examples)

Beyond the primary keys and uniqueness constraints already noted inline above:

| Table | Index | Purpose |
|---|---|---|
| every RLS-protected table | `(organization_id, ...)` composite, leading with `organization_id` | Every query filters by org first — this should be the leftmost index column everywhere |
| `Load` | `(organization_id, status)` | Dispatch Board filtering |
| `Load` | `(organization_id, assigned_dispatcher_id, status)` | "My Loads" view |
| `Load` | `(organization_id, customer_id)` | Customer load history |
| `Load` | `(organization_id, invoiced)` | Ready-to-Invoice queue |
| `Stop` | `(load_id, sequence)` | Ordered stop retrieval |
| `Carrier` | `(organization_id, assignment_eligible)` | Sourcing eligibility filtering |
| `CarrierServiceArea` | `(organization_id, carrier_id)` | "Show this carrier's lane/region preferences"; also supports basic filtering by `origin_state`/`destination_state`/`region_label` for carrier search |
| `Document` | `(organization_id, entity_type, entity_id, is_current_version)` | "Get current documents for this entity" — the single most common Document query |
| `Document` | `(organization_id, scan_status)` | Quarantine/pending-scan monitoring |
| `Invoice` | `(organization_id, status, due_date)` | AR aging / Overdue computation |
| `CarrierPayment` | `(organization_id, status)` | Pending-approval queue |
| `AuditLog` | `(organization_id, entity_type, entity_id, created_at)` | "Show audit history for this record" |
| `AuditLog` | `(organization_id, actor_user_id, created_at)` | "Show this user's activity" |
| `OrganizationMembership` | `(user_id)` | Login → membership lookup (cross-org, hence not leading with organization_id) |

---

## 28. V1 vs. Future-Phase Schema

**Built now (this document):** every table above.

**Explicitly NOT designed/built in V1** (per PRD §2 and Stage 2 workflow boundaries):
- Driver/Truck/Trailer compliance fields (CDL, medical card, HOS, ELD, drug/alcohol, registration/inspection/maintenance) — future columns on existing tables, not new tables.
- `CustomerUser` / `CarrierUser` (future portals) — reserved conceptually (Architecture §14) but no table yet.
- `ImportBatch` (bulk import) — deferred; Stage 2 never drafted this workflow.
- Stop-level Exception tables (No-show, Pickup Refused, Delivery Refused, TONU, Detention/Layover/Lumper as formal exception *records* beyond their already-modeled `ChargeLineItem` accessorial charges) — deferred to a future Exceptions workflow.
- Webhook subscription/delivery tables, EDI transaction tables, public API key/rate-limit tables — deferred with integrations.
- Any AI-specific tables (recommendation logs, confidence scores) — deferred; `AuditLog.actor_type = AI` is the only V1 reservation.
- Tax tables — explicitly out of scope (PRD §8.3).

---

## 29. High-Level Relationship Map

```
User (global) ──< OrganizationMembership >── Organization
                        │                         │
                        │ (roles via              ├──< Customer ──< CustomerContact
                        │  MembershipRole)         │            ├──< CustomerLocation
                        │                          │            └──< CustomerRateAgreement
                        │                          │
                        │                          ├──< Carrier ──< CarrierContact
                        │                          │            ├──< CarrierInsurance ──> Document (COI)
                        │                          │            ├──< CarrierFmcsaVerification
                        │                          │            ├──< CarrierFactoringInfo
                        │                          │            ├──< CarrierServiceArea
                        │                          │            ├──< Driver / Truck / Trailer
                        │                          │            └──< Document (compliance docs)
                        │                          │
                        │                          ├──< Quote ──< QuoteStop
                        │                          │        └──> Load (0..1, on conversion)
                        │                          │
                        │                          ├──< Load ──< Stop
                        │                          │         ├──< CarrierSourcingAttempt ──> Carrier
                        │                          │         ├──1:1─ DispatchRecord ──> Driver/Truck/Trailer
                        │                          │         ├──< CheckCall
                        │                          │         ├──< ChargeLineItem
                        │                          │         ├──< CommunicationActivity / InternalNote
                        │                          │         ├──< Document (Rate Con, BOL, POD, photos)
                        │                          │         └──< InvoiceLoad >── Invoice
                        │                          │
                        │                          ├──< Invoice ──< InvoiceLineItem
                        │                          │            ├──< Payment
                        │                          │            └──< Adjustment
                        │                          │
                        │                          ├──< CarrierPayment ──> Load, Carrier
                        │                          │                  └──> Document (Settlement)
                        │                          │
                        │                          ├──< Notification
                        │                          ├──< DomainEvent
                        │                          └──< AuditLog (universal, references any entity)
                        │
                        └── (Platform Super Admin = User with no membership rows)
```

---

## 30. Stage 4 Database Decision Log — 🔒 15 ORIGINAL ITEMS LOCKED + 1 STAGE 5 ADDENDUM

Physical-schema-level decisions made in producing this design. All 15 original items are confirmed. D9 and D14 were genuine workflow/business gaps (not pure schema choices) and are marked accordingly — both resolved using the recommendation originally proposed, without altering any previously-locked PRD or workflow rule. **D16** was added later, during Stage 5 (UI/UX Design), when designing the Carrier Detail screen surfaced a genuine Stage 4 omission.

| # | Decision | Choice Made | Rationale |
|---|---|---|---|
| D1 | Multi-role storage | `MembershipRole` join table, not an array column on `OrganizationMembership` | Cleaner querying ("all Admins in org X"), extensible if per-role metadata is ever needed |
| D2 | RLS column denormalization | `organization_id` added directly to every child table (Stop, ChargeLineItem, Payment, etc.), not just top-level entities | Keeps every RLS policy a simple equality check, no joins required — matters for both correctness and performance |
| D3 | Org-scoped numbering concurrency | Dedicated `OrganizationSequence` table with row-locking, not native Postgres per-org sequences | Portable, simple to reason about; avoids proliferating DB sequence objects per organization at scale |
| D4 | Document versioning shape | Stable `document_family_id` + `version_number` + `is_current_version` flag, not a `parent_document_id` linked list | Simpler "get current version" query; no chain-walking |
| D5 | Compliance review fields location | Kept directly on `Document` (nullable), not a separate `DocumentReview` table | Only compliance doc types use them; a join table adds complexity for little benefit at this entity count |
| D6 | Settlement/Rate Confirmation documents | Reuse the universal `Document` table (`entity_type` = Load/CarrierPayment), no dedicated tables | Matches the PRD's explicit "one reusable document system" principle |
| D7 | Load Closing checklist snapshot | Stored as `AuditLog.new_value` JSONB on the `Load Closed` event, no dedicated snapshot table | Consistent with the "audit log is the historical record" pattern already used for DispatchRecord |
| D8 | Dispatch history | `DispatchRecord` is mutable (current state only); history lives in `AuditLog` | Matches Workflow 6 §6.9's explicit language exactly |
| D9 | **Accessorial charge-addition workflow** 🔒 | Admin, Operations Manager, Dispatcher, or Accounting may add a `ChargeLineItem` (`source = ADJUSTMENT`) at any time after booking; no approval required; fully audited | ⚠️ Genuine business-rule gap, not just a schema choice — resolved using the low-ceremony pattern already used for Internal Notes/Communication Activity, and the role set already trusted with load financial/operational data elsewhere (Workflows 5, 8) |
| D10 | **Carrier Payment ↔ Charge Line Item allocation** | No allocation — a `CarrierPayment` is always against the load's total carrier balance, never itemized to specific charges | Workflow 9 never specified line-item-level allocation; simplest model matching what was actually locked |
| D11 | Invoice line-item snapshotting | `InvoiceLineItem` rows are copies of `ChargeLineItem` data at invoicing time, not live references | Preserves invoice history if the underlying Load's charges are later adjusted — required by the financial-integrity principle |
| D12 | Address/lane modeling | Inline structured city/state/zip fields on Stop/Quote/RateAgreement, not a shared normalized `Address` entity | These addresses aren't deeply reused/deduplicated the way `CustomerLocation` already is; a shared Address table would add joins without a clear benefit at this scale |
| D13 | Custom document/charge types | Lookup tables (`DocumentTypeDefinition`, `ChargeTypeDefinition`) with an `organization_id nullable` (NULL = system default), not fixed enums | Required — the PRD explicitly mandates org-level custom type creation, which a hardcoded enum cannot support |
| D14 | **AP aging anchor date** 🔒 | Buckets computed from `CarrierPayment.submitted_at`, not a fabricated "carrier payment terms" concept | ⚠️ Genuine business-rule gap, not just a schema choice — resolved by using an existing timestamp rather than inventing a new business rule (no `CarrierPayment.due_date`/carrier payment-terms concept exists anywhere in the locked PRD/workflows) |
| D15 | AuditLog JSONB convention | Field-level diffs for edits, full-entity snapshots for creation/major transitions, both in the same `previous_value`/`new_value` JSONB shape | One flexible convention accommodates both cases without a schema change per event type |
| D16 | **Carrier lane/region preferences** 🔒 *(Stage 5 addendum)* | New `CarrierServiceArea` table (§5) — `type` (LANE/REGION), structured origin/destination for lanes, free-text label for regions, no matching/scoring logic | ⚠️ Genuine Stage 4 omission, caught while designing the Carrier Detail screen (§5.4.6) — PRD §Carriers and Workflow 3 §3.6 both describe this as trackable, but no field/table existed anywhere in the original 15-item pass. Kept deliberately minimal per PRD §3.6's explicit "simple and searchable/filterable... not a sophisticated matching engine" instruction; no effect on `assignment_eligible` or any other locked gate |

---

## 31. Stage 4 Completion

All 15 original Decision Log items are locked — the 13 schema-level judgment calls, plus **D9** (accessorial charge-addition permissions/no-approval rule) and **D14** (AP aging anchor date), both resolved as business-rule additions that fill gaps Stage 2 left open without altering any previously-locked PRD or workflow rule. **D16** (carrier lane/region preferences) was added afterward, during Stage 5, as a corrective addendum — same standard applied: minimal schema, no new business rule beyond what the PRD/Workflow 3 already required.

**Stage 4 is complete, now including the D16 addendum.** Stage 5 (UI/UX Design) and Stage 6 (Technical Architecture) may proceed against this schema. No migrations, ORM models, or application code have been written — this remains a logical schema design only, carried forward as the source of truth until Stage 7 (Development).
