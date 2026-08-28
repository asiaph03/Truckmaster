# Stage 5: UI/UX Design
**Status:** 5.1–5.6 🔒 FULLY LOCKED (58/58 decisions resolved). 5.7 Prototype complete — see [prototype/index.html](prototype/index.html). **Stage 5 is complete.**

## 5.7 Prototype

An interactive, single-file HTML/CSS/JS prototype implementing all 8 critical screens against the locked spec: Dispatch Board (Table/Kanban/Calendar), Load Detail, Customer Detail, Carrier Detail, Invoice Builder/Detail, and Load Closing. Frontend-only — mock in-memory data, no backend/database/auth/payment integration, per your instruction.

**Notable implementation choices, carried over faithfully from the locked spec:**
- A **"PROTOTYPE: simulate role"** selector in the top bar (clearly labeled as prototype-only, not a real feature) lets you toggle between all 5 roles and see the permission-based hiding/redaction rules from §5.1.6/§5.4 apply live — financial columns/tabs disappearing for Dispatcher, Margin staying hidden from Sales/Booking even on owned deals, etc.
- Kanban drag-and-drop implements the exact direct/assisted/blocked rules from §5.4.2, and the **`Move to…`** kebab menu (INT-13) routes through the identical assisted-transition modals as the drag interaction — verified both paths produce the same result.
- Calendar's **`Reschedule`** action (INT-13) updates only `appointment_datetime`, never Load/Stop status, exactly as locked.
- Carrier Detail's Eligibility Checklist is computed live from the same 7-condition logic as Workflow 3 §3.8, including the D16 Lane/Region Preferences addition.
- Financial redaction in Load Detail's Activity History (LD-6) is implemented as presentation-layer regex redaction over otherwise-complete audit records — mirroring the "redact at the authorization layer, never alter the underlying record" principle.
- Document upload simulates the malware-scan gate (`PENDING` → `CLEAN` after a short delay) before a file becomes downloadable, per Architecture Decision 10.

**Known prototype-only simplifications (not business-rule gaps — just scope reductions appropriate for a frontend-only mock):**
- Quote creation (Workflow 4's Quote path) is stubbed with an explanatory message rather than fully built — Direct Booking is fully implemented; both share the same downstream Load lifecycle, so this doesn't affect coverage of the 8 critical screens.
- Carrier Payment approval is simplified to Draft → Pending Approval on submission (the Approve/Reject step itself isn't wired into a separate reviewer action in this pass, though the self-review/no-approval-yet state is shown).
- Global Search opens a real overlay but doesn't execute a live query against mock data.
- Customer/Carrier "Edit," "Add Contact/Location/Rate Agreement," and a few similar secondary CRUD actions show a confirmation toast rather than a full form — the primary detail views, tabs, and permission gating (the actual subject of Stage 5) are fully functional.

None of these simplifications required inventing a new business rule — where the prototype couldn't fully represent something, it either implements the real rule at reduced fidelity (documented above) or is out of the 8-screen scope entirely.

**Verified in-browser:** no console errors; Table/Kanban/Calendar/Load Detail/Carrier Detail/role-switching interactions manually tested and confirmed working as specified.

---

**Stage 5 (UI/UX Design) is complete: Information Architecture, Design System, Application Shell, all 8 Critical Screens, Interaction/State Specifications, the full Decision Log, and the working Prototype.** Ready to proceed to Stage 6 (Technical Architecture) when you are — not started per your instruction to stop here.
**Source of truth:** [docs/PRD.md](PRD.md), [docs/workflows/](workflows/), [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/architecture-decisions.md](architecture-decisions.md), [docs/DATABASE_DESIGN.md](DATABASE_DESIGN.md)
**Scope note:** UI/UX design and prototype/specification only. No production code. No new business rules — anything a screen needs that isn't already locked is flagged, not invented.

---

## 5.1 Information Architecture / Navigation

### 5.1.1 Two-Tier Structure

The application has two entirely separate navigational contexts, matching the Stage 3/4 identity model (`User → OrganizationMembership → Organization`, plus the Platform Super Admin):

| Context | Who | Scope |
|---|---|---|
| **Organization workspace** | Any user with an active `OrganizationMembership` | Everything below — the actual TMS |
| **Platform console** | Platform Super Admin only (`User.is_platform_super_admin`) | Organization provisioning, platform-level configuration — a separate, minimal shell, out of scope for this stage's critical-screen list, but noted here for IA completeness since it's a real, distinct navigational context |

Everything from here on describes the **Organization workspace** — the shell every internal user (Admin, Operations Manager, Dispatcher, Sales/Booking, Accounting) lives in.

### 5.1.2 App Shell Pattern

**Persistent left sidebar** for primary navigation + a **top bar** for global/contextual actions. This is the standard dense-enterprise-SaaS pattern and fits the "desktop productivity over marketing visuals" direction and the multi-column/table-heavy screens ahead.

```
┌─────────────────────────────────────────────────────────┐
│ TOP BAR: [Org switcher*] [Global Search] [Notif 🔔] [User ▾] │
├───────────┬─────────────────────────────────────────────┤
│           │                                              │
│  SIDEBAR  │              MAIN CONTENT AREA               │
│  (nav)    │        (breadcrumb + screen content)          │
│           │                                              │
└───────────┴─────────────────────────────────────────────┘
```
*Org switcher only renders if the logged-in user has more than one active `OrganizationMembership` (Decision 1) — hidden entirely for the common single-org V1 user, so it never adds visual clutter for the default case.

### 5.1.3 Primary Navigation (Sidebar)

| Nav Section | Contains | Primary Roles | View-Only / Hidden For |
|---|---|---|---|
| **Dashboard** | Role-aware home (KPIs per PRD §9 role dashboards) | All roles (content varies) | — |
| **Loads** | Dispatch Board (Table/Kanban/Calendar), Load Search, Quotes | Admin, Ops Manager, Dispatcher, Sales/Booking (Quotes) | Financial columns (rate/margin) hidden from Dispatcher throughout |
| **Customers** | Customer list, Customer Detail (contacts, locations, rate agreements) | Admin, Ops Manager, Sales/Booking, Accounting (create per Workflow 2) | Dispatcher: view-only, no create |
| **Carriers** | Carrier list, Carrier Detail (compliance, insurance, drivers/trucks/trailers), Compliance Review Queue | Admin, Ops Manager, Dispatcher (create per Workflow 3) | Sales/Booking, Accounting: view-only. Compliance Review Queue: Compliance Reviewer permission only |
| **Billing** | Customer Invoices, Carrier Pay, AR Aging, AP Aging | Accounting, Admin | **Hidden entirely from Dispatcher.** Sales/Booking: no access except their own deals' invoice status (per PRD §7) — flagged in 5.1.6 |
| **Documents** | Document Center (cross-entity search) | All roles, filtered to what they can already see per entity permission | — |
| **Reports** | Report library, saved views, dashboards | All roles (content/reports available vary — PRD §9 permission matrix) | — |
| **Settings** | Users & Roles, Organization Settings, Compliance permission assignment | Admin only (Org Admin) | Hidden from all other roles |

**Not top-level nav items** — reached only in context, never as their own sidebar entry:
- Drivers / Trucks / Trailers (inside Carrier Detail)
- Charge Line Items, Check Calls, Carrier Sourcing Attempts, Communication Activity, Internal Notes (inside Load Detail)
- Dispatch Record (inside Load Detail)

This keeps the sidebar to 7 items, matching the "fast scanning, minimal decoration" direction rather than surfacing every database entity as its own nav item.

### 5.1.4 Sitemap Tree

```
/ (Dashboard — role-aware home)

/loads
  /loads/board                    Dispatch Board
    ?view=table | kanban | calendar
  /loads/search                   Load Search (all loads, exportable)
  /loads/:loadId                  Load Detail
  /quotes                         Quote list
  /quotes/:quoteId                Quote Detail
  /quotes/new                     Quote Creation
  /loads/new                      Direct-to-Booked Load Creation

/customers
  /customers                      Customer list
  /customers/new                  Customer Creation
  /customers/:customerId          Customer Detail
    (tabs: Overview, Contacts, Locations, Rate Agreements, Loads, Invoices)

/carriers
  /carriers                       Carrier list
  /carriers/new                   Carrier Creation
  /carriers/:carrierId            Carrier Detail
    (tabs: Overview, Compliance, Insurance, Contacts, Drivers, Trucks, Trailers, Loads, Factoring)
  /carriers/compliance-queue      Compliance Review Queue

/billing
  /billing/invoices                Customer Invoice list
  /billing/invoices/:invoiceId     Invoice Detail
  /billing/carrier-pay             Carrier Payment list
  /billing/carrier-pay/:paymentId  Carrier Payment Detail
  /billing/ar-aging                AR Aging report
  /billing/ap-aging                AP Aging report

/documents                        Document Center

/reports                          Report library
  /reports/:reportId              Individual report view

/settings                         Users & Roles (Admin only)
  /settings/organization          Organization Settings
```

Load-scoped sub-resources (Stops, Charge Line Items, Check Calls, Sourcing Attempts, Dispatch Record, Documents, Communication Activity, Internal Notes) are **tabs or sections within `/loads/:loadId`**, not separate routes with their own nav presence — consistent with §5.1.3.

### 5.1.5 Navigation Patterns

- **Breadcrumbs** inside the content area for every detail screen (e.g., `Loads > LOAD-000456`, `Carriers > ABC Trucking > Compliance`), not in the top bar — keeps the top bar reserved for global actions.
- **Global Search** (top bar) is a fast jump-to tool — searches Load #, Customer name, Carrier name, Invoice # — and is distinct from the **Load Search** screen (§5.1.4), which is the full filterable/exportable operational tool. Global search jumps you to one record; Load Search lets you filter/export many.
- **Notification bell** opens a dropdown list of unread in-app notifications (compliance expiration warnings, per Workflow 3 — the only concrete V1 notification type), each linking to its related entity.
- **User menu** (top-right): profile, org switcher (if applicable), logout. Deactivation is an admin action performed on *other* users via Settings → Users, not a self-service menu item.

### 5.1.6 Role-Based Navigation Visibility

| Role | Dashboard | Loads (ops) | Loads (financial fields) | Customers | Carriers | Billing | Documents | Reports | Settings |
|---|---|---|---|---|---|---|---|---|---|
| **Admin** | Full | Full | Full | Full | Full | Full | Full | Full | Full |
| **Operations Manager** | Full | Full | Full* | Full | Full | Full* | Full | Full | — |
| **Dispatcher** | Ops-focused | Full (own + org loads) | **Hidden** | View-only | Full (create/manage) | **Hidden** | Ops docs only | Ops reports only | — |
| **Sales/Booking** | Sales-focused | Create/view (no carrier sourcing/dispatch actions) | Own deals only* | Full (create/manage) | View-only | Own deals' invoice status only* | Customer-facing docs | Sales reports only | — |
| **Accounting** | Accounting-focused | View-only (no sourcing/dispatch actions) | Full | Full (create/manage) | View-only | Full | Financial docs | Financial reports | — |

**\*Flagged — not fully pinned down by Stage 1–4 and needs your confirmation (see §5.1.7), not silently assumed here.**

### 5.1.7 IA Decisions — 🔒 LOCKED

1. **Operations Manager financial visibility:** Full parity with Admin in V1, subject to the existing permission model (revenue, cost, margin, invoices, carrier pay all visible where permissions allow). Dispatcher remains restricted from financial reporting/visibility exactly as already specified in Stage 1–2.
2. **Sales/Booking "own deals" scope:** Defined primarily by **Account Owner** (`Customer.account_owner_user_id`, and by extension Quotes/Loads under that customer). If no Account Owner is assigned, the **creator** (`created_by_user_id`) is the temporary ownership fallback for visibility. This never overrides Admin's or Operations Manager's organization-wide access.
3. **Dispatch Board + Load Search:** One top-level **Loads** navigation section containing both as separate pages/views — Dispatch Board (operational workspace) and Load Search (general-purpose search/filter/export) — not separate top-level nav items.

These are Stage 5 IA/UX-layer decisions only; they do not alter any locked PRD, workflow, architecture, or database rule.

---

**Section 5.1 (Information Architecture) — 🔒 LOCKED.**

---

## 5.2 Design System

**Brand reference:** Truck Master Dispatching Services logo (uploaded). Primary blue `#1A2BC3`, white, dark/black accent from the headphone artwork. The script wordmark is a **logo-only asset** — never used as a UI typeface. All application UI text uses a clean sans-serif.

### 5.2.1 Color Tokens

**Brand**
| Token | Hex | Usage |
|---|---|---|
| `brand-600` (primary) | `#1A2BC3` | Primary buttons, active nav item, selected states, links, key highlights |
| `brand-700` (hover/active) | `#12208F` | Hover/pressed state for primary buttons and active elements |
| `brand-100` (tint) | `#E7E9FB` | Selected-row background, active-nav background, subtle highlight fills |
| `brand-50` (faint tint) | `#F4F5FE` | Hover background on list rows/menu items (very subtle) |

**Neutrals** (the dominant palette — per your explicit "predominantly white/light neutral" direction)
| Token | Hex | Usage |
|---|---|---|
| `neutral-0` | `#FFFFFF` | Page/card background |
| `neutral-50` | `#F7F8FA` | App shell background (behind cards/tables) |
| `neutral-100` | `#F0F1F4` | Table header background, subtle section dividers |
| `neutral-200` | `#E2E4E9` | Borders, table row dividers |
| `neutral-300` | `#CBCED6` | Disabled borders, input borders (default) |
| `neutral-400` | `#9297A3` | Placeholder text, disabled text |
| `neutral-500` | `#6B707C` | Secondary/muted text |
| `neutral-700` | `#3C4049` | Body text |
| `neutral-900` | `#16181D` | Headings, primary text, matches the logo's dark accent |

**Semantic (status colors)** — deliberately distinct from `brand-600` so status meaning is never confused with "this is clickable/branded":
| Token | Hex (text) | Hex (bg tint) | Usage |
|---|---|---|---|
| `success-600` | `#157F3C` | `#E5F6EA` | Active, Approved, Complete, Paid, Eligible, Clean (scan) |
| `warning-600` | `#B4770B` | `#FDF1DC` | At Risk, Partial, Pending Review, Pending Approval, Overdue-adjacent caution |
| `danger-600` | `#C4293A` | `#FBE7E9` | Blocked, Rejected, Delayed, Ineligible, Infected/Scan Failed, Overdue, Void |
| `info-600` (teal, not brand blue) | `#0E7490` | `#E1F2F5` | In Transit / general "in progress" informational badges where blue-as-brand would be ambiguous |

**Status badge mapping** (every enum value from [DATABASE_DESIGN.md](DATABASE_DESIGN.md) accounted for, so no status is left undesigned):

| Entity.Field | Value | Badge Color |
|---|---|---|
| Load.status | BOOKED, CARRIER_SOURCING, CARRIER_ASSIGNED, RATE_CONFIRMATION, DISPATCHED, PICKUP | `brand` (in progress) |
| Load.status | IN_TRANSIT | `info` |
| Load.status | DELIVERED, CLOSED | `success` |
| Stop.status | PENDING | `neutral` |
| Stop.status | ARRIVED | `brand` |
| Stop.status | COMPLETED | `success` |
| Quote.status | OPEN | `brand` |
| Quote.status | WON | `success` |
| Quote.status | LOST | `neutral` (muted, not danger — losing a quote isn't an error state) |
| Carrier.status | PENDING | `neutral` |
| Carrier.status | ACTIVE | `success` |
| Carrier.status | INACTIVE | `neutral` |
| Carrier.status | BLOCKED | `danger` |
| Carrier.assignment_eligible | true / false | `success` "Eligible" / `danger` "Ineligible" — **always shown separately from Carrier.status**, per Workflow 3's explicit separation |
| Document.review_status | PENDING_REVIEW | `warning` |
| Document.review_status | APPROVED | `success` |
| Document.review_status | REJECTED, EXPIRED | `danger` |
| Document.scan_status | PENDING | `neutral` |
| Document.scan_status | CLEAN | `success` |
| Document.scan_status | INFECTED, SCAN_FAILED | `danger` |
| Invoice.status | DRAFT | `neutral` |
| Invoice.status | SENT | `brand` |
| Invoice.status | PARTIALLY_PAID | `warning` |
| Invoice.status | PAID, CREDITED | `success` |
| Invoice.status | OVERDUE (computed) | `danger` |
| Invoice.status | VOID | `neutral` (struck-through label treatment) |
| CarrierPayment.status | DRAFT | `neutral` |
| CarrierPayment.status | PENDING_APPROVAL | `warning` |
| CarrierPayment.status | APPROVED | `brand` |
| CarrierPayment.status | PAID | `success` |
| Load.pod_status | NOT_RECEIVED | `danger` (soft, per Workflow 7/10 — a warning-weight red, not a blocking one) |
| Load.pod_status | PARTIAL | `warning` |
| Load.pod_status | COMPLETE | `success` |
| Load.risk_status | NORMAL | *(no badge shown — absence of a badge is the "normal" state, avoids visual noise)* |
| Load.risk_status | AT_RISK | `warning` |
| Load.risk_status | DELAYED | `danger` |

### 5.2.2 Typography

**UI typeface:** **Inter** (or system-ui fallback stack: `-apple-system, "Segoe UI", Roboto, Inter, sans-serif`) — chosen for high legibility at small sizes in dense tables, a large weight range, and a neutral "modern SaaS" character that won't compete with the logo's script wordmark.

**Type scale**
| Token | Size / Line-height | Weight | Usage |
|---|---|---|---|
| `text-display` | 28px / 36px | 600 | Page titles (rare — most screens use `text-h1`) |
| `text-h1` | 22px / 28px | 600 | Screen/section titles ("Load LOAD-000456") |
| `text-h2` | 17px / 24px | 600 | Card/panel headers |
| `text-body` | 14px / 20px | 400 | Default body text, form values |
| `text-body-medium` | 14px / 20px | 500 | Emphasized body text, table primary column |
| `text-small` | 13px / 18px | 400 | Secondary text, table cells, metadata |
| `text-caption` | 12px / 16px | 500 | Labels, badges, letter-spaced section headers (echoing the logo's "DISPATCHING SERVICES" treatment) |

Numeric/currency values use **tabular figures** (`font-variant-numeric: tabular-nums`) throughout tables and financial screens so columns of numbers align vertically — important for a "dense but readable operational" table experience.

### 5.2.3 Spacing, Radius, Shadow

**Spacing scale** (4px base unit): `4, 8, 12, 16, 20, 24, 32, 40, 48, 64` — used for all padding/margin/gap values, no arbitrary one-off spacing.

**Border radius**
| Token | Value | Usage |
|---|---|---|
| `radius-sm` | 4px | Inputs, badges, small buttons |
| `radius-md` | 8px | Buttons, cards, dropdowns |
| `radius-lg` | 12px | Modals, drawers |

Deliberately restrained (not pill-everything/playful) — matches "professional, modern, clean" over a softer consumer-app feel.

**Shadows** (low-opacity, minimal — "minimal unnecessary decoration")
| Token | Usage |
|---|---|
| `shadow-sm` | Cards resting on the `neutral-50` background |
| `shadow-md` | Dropdowns, popovers, drawers |
| `shadow-lg` | Modals |

### 5.2.4 Icons

Single consistent icon set: **Lucide** (open-source, consistent 24×24 stroke-based grid, scales cleanly to 16/20px for dense table use, MIT-licensed). No mixing icon families. Default stroke width 1.5–2px, colored `neutral-500` for inactive/secondary icons and `brand-600` for active/interactive icon buttons.

### 5.2.5 Core Components

**Buttons**
| Variant | Style | Usage |
|---|---|---|
| Primary | `brand-600` fill, white text | The one primary action per screen/section (e.g., "Create Load," "Send Invoice") |
| Secondary | White fill, `neutral-300` border, `neutral-900` text | Secondary actions ("Cancel," "Save Draft") |
| Tertiary/Ghost | No fill, no border, `brand-600` text | Low-emphasis actions, inline table-row actions |
| Destructive | `danger-600` text or fill (fill for the most severe: Void, Deactivate) | Irreversible/high-caution actions |
| Icon button | Square, `neutral-500` icon, `neutral-100` hover bg | Row-level actions (kebab menu, etc.) |

Sizes: `sm` (28px height, table toolbars), `md` (36px height, default), `lg` (44px height, primary form-page actions). States: default / hover / active / focus-visible (2px `brand-100` ring) / disabled (`neutral-300` text+border, no pointer) / loading (spinner replaces label, button stays same width).

**Inputs, Selects, Date Pickers**
- Text/number/textarea: `neutral-0` bg, `neutral-300` border, `radius-sm`, 36px height (single-line). Focus: `brand-600` border + `brand-100` ring. Error: `danger-600` border + error text below in `danger-600`. Label above, optional helper text below, required fields marked with a `*`.
- **Currency inputs**: right-aligned, `$` prefix, tabular-nums, always formatted to 2 decimals on blur — matches the locked `DECIMAL(12,2)` standard (Architecture Decision 6) so what the user sees always matches what's stored.
- Select (single): same shell as text input + chevron icon; dropdown panel uses `shadow-md`.
- **Searchable combobox**: used specifically for Customer/Carrier/Driver/Truck/Trailer pickers (per Workflow 5/6's "select from reusable records or manual entry" pattern) — type-to-filter, with a persistent "+ Enter manually" option at the bottom of the list to satisfy the manual-entry fallback.
- Date picker: calendar popover, `shadow-md`, today highlighted with `brand-100`, selected date filled `brand-600`. Date**time** variant (for `appointment_datetime`, `actual_arrival`, etc.) adds a time input alongside the calendar.

**Search**
- **Global search** (top bar): click-to-open command-palette-style overlay (centered, `shadow-lg`), type-ahead results grouped by entity type (Loads / Customers / Carriers / Invoices), keyboard-navigable.
- **In-page filter search**: a standard text input with a search icon, left-aligned in table toolbars, filters the current table client-side or via query param — distinct visual treatment (inline, not an overlay) from global search.

**Tabs**
Horizontal, underline-style (2px `brand-600` underline on active tab, `neutral-500` text on inactive, `neutral-900` on hover). Used on every detail screen (Customer/Carrier/Load Detail). Tab labels may carry a count badge (`text-caption`, `neutral-100` pill) e.g. "Documents (4)".

**Tables** — the most important component for this product
- Header row: `neutral-100` background, `text-caption` labels (uppercase, letter-spaced — echoing the logo's wordmark treatment), sortable columns show a sort-direction chevron on hover/active.
- Row height: **dense by default** (36–40px), no zebra striping — instead a 1px `neutral-200` bottom border per row plus a `neutral-50` background on hover. This reads as cleaner/more modern than zebra striping while staying scannable.
- Numeric/currency columns: right-aligned, tabular-nums.
- Status columns: render the status badge (§5.2.1), never raw enum text.
- Row selection: checkbox column (only present on screens with locked bulk actions — Dispatch Board table view, per PRD §Dispatch Board bulk actions), selected rows get `brand-50` background.
- Row actions: kebab (⋮) icon button, right-aligned, opens a dropdown menu — keeps rows uncluttered vs. inline action buttons.
- Empty state and pagination: see §5.2.6/5.2.7.

**Pagination**
Classic page-based control at the table footer: `‹ Prev  1 2 3 … 12  Next ›` + a result count ("Showing 1–50 of 612") + page-size selector (25/50/100). Chosen over infinite scroll for predictability in an operational tool where users reference specific result positions.

**Status Badges**
Pill shape (`radius-sm`, not fully round — consistent with the restrained-radius direction), `text-caption` weight, colored background tint + matching text color per §5.2.1's mapping table. Never color-only — always paired with the status text label (accessibility — see §5.6).

**Alerts (inline banners)**
Left-accent-bordered banner (4px colored left border + tinted background), icon + message + optional action link. Variants: info (`info-600`), warning (`warning-600`), danger (`danger-600`), success (`success-600`). Used for: POD-incomplete warning (Workflow 8 §8.2), Load Closing checklist warnings (Workflow 10 §10.6), Carrier ineligibility block (Workflow 5 §5.3).

**Toasts**
Top-right, stacked, auto-dismiss after 4s (manual close always available), `shadow-md`, same 4 semantic variants as alerts. Used for confirmations after actions complete (e.g., "Invoice sent," "Carrier payment approved").

**Modals**
Centered overlay, `shadow-lg`, `radius-lg`, max-width 480px (confirmation) or 640px (form-in-modal, e.g., "Add Adjustment"). Header (title + close icon) / body / footer (secondary + primary action, right-aligned). Backdrop click does **not** dismiss modals that represent a required decision (e.g., reason-required rejections) — only dismissible via explicit Cancel/X, to avoid accidental loss of in-progress input.

**Drawers**
Right-side slide-in panel, `shadow-lg`, ~480px wide, used for quick-view without leaving a filtered list context — e.g., clicking a row in Dispatch Board's Table view opens a Load summary drawer with an "Open Full Detail →" link, rather than always navigating away.

**Cards**
`neutral-0` background, `shadow-sm`, `radius-md`, `neutral-200` border. Used for Dashboard KPI tiles and grouped sections within detail pages (e.g., a "Compliance" card on Carrier Detail).

**Empty States**
Centered icon (`neutral-300`) + `text-body-medium` message + optional primary button. E.g., "No loads match your filters" / "No documents uploaded yet" + "Upload Document" button.

**Loading / Skeleton States**
Skeleton rows (animated `neutral-100`→`neutral-200` shimmer) matching the real row height for tables; skeleton blocks for cards/detail panels. Avoid spinner-only loading for anything on a content-heavy screen (tables, detail pages) — reserve spinners for buttons and small isolated actions.

**Error States**
- Inline field errors: `danger-600` border + text below the field.
- Page-level: centered icon + message + "Retry" button (for failed data loads).
- **Permission-denied** is visually distinct from "not found" — a dedicated "You don't have access to this" state (lock icon, `neutral-500`) rather than a generic 404, since financial-visibility restrictions (§5.1.6) will legitimately produce this for some users.

**Confirmation Dialogs**
Modal variant reserved for irreversible/significant actions already defined in the locked workflows — Deactivate User (Workflow 1), Void Invoice (Workflow 8), Reject Document/Carrier Payment (reason required — Workflows 3/9), Close Load with incomplete checklist (acknowledgment — Workflow 10). Destructive confirmations use the Destructive button variant for the primary action; the button label restates the action ("Deactivate User," never a bare "Confirm") so users never click blind.

### 5.2.6 Design System → Workflow Traceability

Every component above exists because a locked workflow needs it — nothing was added speculatively:
- Segregation-of-duties reason-required modals ← Workflows 3 (§3.4), 9 (§9.4)
- Non-blocking warning banners ← Workflows 5 (§5.3, hard-block variant), 8 (§8.2), 10 (§10.6)
- Searchable combobox with manual-entry fallback ← Workflows 5 (§5.2), 6 (§6.1)
- Checklist-style component (needed for Load Closing, §5.4 later) ← Workflow 10
- Multi-role assignment control (needed for Settings → Users) ← Workflow 1 (§7)

---

**Section 5.2 (Design System) — 🔒 LOCKED**, including the Drawer component and all component-to-workflow mappings in §5.2.6.

---

## 5.3 Application Shell

Scope: the **Organization workspace** shell (§5.1.1) — the frame every internal user (Admin, Operations Manager, Dispatcher, Sales/Booking, Accounting) works inside. The Platform console (Super Admin) shell is out of scope, consistent with its exclusion from the critical-screen list.

### 5.3.1 Overall Layout & Dimensions

```
┌──────────────────────────────────────────────────────────────────────┐
│ TOP BAR — 56px height, neutral-0 bg, neutral-200 bottom border        │
│ [☰][Logo mark] [Org switcher▾]        [⌘K Search]   [🔔3] [Avatar▾]   │
├───────────────┬──────────────────────────────────────────────────────┤
│               │ PAGE HEADER — breadcrumb, title, primary actions      │
│  SIDEBAR      ├──────────────────────────────────────────────────────┤
│  240px        │                                                      │
│  (64px        │            MAIN CONTENT AREA                         │
│  collapsed)   │            neutral-50 bg, scrolls independently       │
│  neutral-0 bg │            content max-width: none (tables use       │
│  fixed, full  │            full available width; forms cap ~720px)   │
│  height       │                                                      │
│               │                                                      │
└───────────────┴──────────────────────────────────────────────────────┘
```

- **Top bar** (56px) and **sidebar** (240px expanded / 64px collapsed) are both fixed/pinned; only the main content area scrolls.
- **Main content area** background is `neutral-50` (per §5.2.1) so white `neutral-0` cards/tables/panels visually lift off it — this is what keeps the workspace "predominantly white/light neutral" while still giving content clear boundaries.
- Minimum supported viewport width: **1280px** (desktop-first, per your Platform decision). Below that, the layout is not optimized — content may require horizontal scroll within tables rather than reflowing, since responsive/mobile support is explicitly out of scope for V1. See §5.3.9 for how this is kept from blocking future responsive work.

### 5.3.2 Global Navigation / Sidebar

- Top of sidebar: collapse toggle (☰) + logo mark (icon-only version of the truck/headphones mark, not the full wordmark lockup — the script wordmark is too detailed to read well at sidebar-icon scale, consistent with §5.2's "logo-only, not a UI typeface" rule extending to "not a cramped UI icon" either).
- Nav items: icon (Lucide, 20px) + label, one row per top-level section from §5.1.3 (Dashboard, Loads, Customers, Carriers, Billing, Documents, Reports, Settings). Each item is 40px tall, `radius-sm`, with 8px horizontal inset from the sidebar edge.
- Nav items with sub-pages (Loads, Billing, Settings) expand in place (accordion) to show their sub-items (e.g., Loads → Dispatch Board, Load Search, Quotes) when active or manually expanded — not a flyout submenu, to keep the interaction simple and consistent with a fixed-width sidebar.
- Bottom of sidebar: nothing persistent (no footer clutter) — user identity/actions live in the top bar (§5.3.4), keeping the sidebar purely navigational.

### 5.3.3 Organization Switcher

- Renders **only** if the logged-in user's `User → OrganizationMembership` set contains more than one `ACTIVE` membership (Architecture Decision 1) — for the common V1 single-org user, this control does not render at all, so it never adds clutter to the default case.
- Placement: top bar, immediately right of the logo mark, styled as a text button with the current org name + chevron.
- Opens a small dropdown (`shadow-md`) listing every organization the user has active membership in; selecting one switches `app.current_org_id` context and reloads the workspace into that organization — a full context switch, not a partial in-place merge, consistent with the tenant-isolation model (Architecture §2).

### 5.3.4 User / Profile Menu

- Placement: top bar, far right — avatar (initials-based, `brand-100` bg + `brand-700` text, since no user-photo-upload feature is in scope) + chevron.
- Menu contents: user name + email (display only), current role badge(s) for this organization (reflecting `MembershipRole`), a divider, then:
  - "Settings" (only rendered for Admin — matches §5.1.6's Settings visibility)
  - "Log out"
- No "My Profile" self-edit item in V1 — no workflow defines self-service profile editing (name/email changes), so it's intentionally omitted rather than invented. Flagged in §5.6.

### 5.3.5 Page Header Structure

Every screen below the top bar uses the same header pattern, directly under the top bar and above the main content:

```
[Breadcrumb trail]
[Page/Entity Title]                              [Secondary action] [Primary action]
[Status badge(s), if the page represents a single entity — e.g., Load status + risk]
```

- Breadcrumb: `text-small`, `neutral-500`, `›` separator, current page in `neutral-900` (not a link). Truncates the middle segment with `…` on very deep paths (e.g., `Carriers › … › Compliance`) rather than wrapping to a second line.
- Title: `text-h1`. For entity detail pages, this is the entity's human identifier (`LOAD-000456`, customer legal name, invoice number) — never a raw UUID.
- Primary action is always the single most important action for that screen (e.g., "Dispatch Load," "Send Invoice") using the Primary button variant (§5.2.5); secondary actions use the Secondary/Tertiary variants. This enforces the "one primary action" rule from the button spec consistently at the shell level, not per-screen.
- Status badges sit directly under the title for single-entity pages, using the exact mapping from §5.2.1 — this is the one place users should look to understand "what state is this record in" at a glance.

### 5.3.6 Global Search

- Trigger: click the top-bar search field, or the `⌘K` / `Ctrl+K` keyboard shortcut from anywhere in the workspace.
- Opens a centered command-palette overlay (`shadow-lg`, per §5.2.5) over a dimmed backdrop.
- Type-ahead results grouped by entity type (Loads, Customers, Carriers, Invoices), each group showing up to 5 matches with a "See all results" link if more exist.
- Results respect the requesting user's permissions exactly as list/detail screens do (§5.1.6) — global search never surfaces a Load's financial fields to a Dispatcher, for example, since it queries the same permission-scoped service layer (Architecture §4), not a separate unscoped index.
- Escape or backdrop click closes it; no result persists any state.

### 5.3.7 Notifications Area

- Bell icon in the top bar, with a small numeric badge (`danger-600` fill, white text) showing unread count — hidden entirely when count is 0 (no empty "0" badge).
- Click opens a dropdown panel (`shadow-md`, ~360px wide, max-height with internal scroll) listing notifications newest-first.
- Each row: unread indicator dot (`brand-600`), message text, relative timestamp ("2h ago"), and is a full-row link to the related entity (e.g., a compliance-expiration notification links straight to that Carrier's Compliance tab).
- Per Workflow 3 (§3.10), the only concrete V1 notification type is **compliance/insurance expiration warnings** (30/15/7-day thresholds) directed to Compliance Reviewers and Operations Managers — so in practice this panel will be empty for most Dispatcher/Sales/Accounting users at V1 launch. The component itself is generic (any future notification type slots in without a redesign), but its V1 content is intentionally limited to what Workflow 3 actually defines — not populated with invented notification types.
- Empty state: centered bell-slash icon + "You're all caught up" (§5.2.5 empty-state pattern).
- No explicit "mark all as read" bulk action in V1 (not specified anywhere) — opening/clicking an individual notification marks that one read. Flagged in §5.6 as a possible future refinement, not invented now.

### 5.3.8 Sidebar Collapse / Expand Behavior

- Toggle icon (☰) at the top of the sidebar switches between 240px (expanded: icon + label) and 64px (collapsed: icon only, centered).
- Collapsed state shows a `shadow-md` tooltip with the label on hover, since icons alone aren't reliably identifiable for less-frequent sections (Billing, Reports).
- The active section's accordion sub-items (§5.3.2) are hidden while collapsed and reappear on re-expand — collapsed mode is a pure space-saving mode, not a differently-organized nav.
- User preference (expanded/collapsed) persists per-user across sessions (stored client-side), so a Dispatcher who prefers the collapsed rail for more table width doesn't have to re-collapse it every login.

### 5.3.9 Responsive Behavior Within V1 Desktop-First Scope

- **In scope:** the shell is fluid between 1280px and very large monitors — the sidebar stays fixed-width, the main content area's tables/panels expand to fill available width (important for the "dense operational tables" direction — more width should show more columns/data, not just more whitespace).
- **Explicitly out of scope:** any breakpoint-driven mobile/tablet layout (stacked nav, hamburger-only shell, touch-optimized controls).
- **Forward-compatibility guardrail** (per the PRD's "avoid making future responsive support unnecessarily difficult" instruction): the shell is built with the sidebar and top bar as structurally separate, independently-positioned regions (not a single rigid grid that assumes their exact pixel dimensions everywhere downstream) — so a future responsive pass can collapse the sidebar into an off-canvas drawer without restructuring the page-header/content patterns every screen already uses. This is a construction guideline for Stage 7, not a V1 deliverable itself.

### 5.3.10 Active Navigation States

Directly from the §5.2.1 tokens, applied consistently:
- **Active top-level nav item:** `brand-100` background fill, `brand-700` text/icon, plus a 3px `brand-600` left accent bar (the accent bar is what remains visible/legible even in the collapsed 64px sidebar state, where the background-fill alone would be harder to notice against other icons).
- **Active sub-item** (within an expanded accordion section): same treatment at a smaller scale (no left accent bar — that's reserved for top-level, to keep a clear one-primary-indicator hierarchy).
- **Hover (inactive item):** `neutral-100` background, no color change to icon/text.
- **Focus-visible (keyboard nav):** 2px `brand-100` ring, matching the input focus treatment in §5.2.5 for consistency across the whole system.

### 5.3.11 Permission-Aware Navigation Visibility

- Navigation items the current user's role(s) cannot access at all are **hidden entirely**, not shown-disabled — e.g., a Dispatcher never sees a "Billing" item they'd only bounce off of. This follows standard enterprise-UX practice: a visible-but-disabled nav item invites confusion ("why can't I click this?") where Stage 1–2 never defined any in-app appeal/request-access flow to explain it.
- Exactly which items render per role is a direct application of the §5.1.6 matrix — the shell has no separate permission logic of its own; it reads the same role/permission resolution the rest of the application uses (Architecture §4's centralized authorization module).
- Sub-item-level visibility follows the same rule (e.g., Sales/Booking sees "Loads → Quotes" and "Loads → Load Search" but the Dispatch Board's *financial columns* are hidden at the component level within that page, not by hiding the Dispatch Board nav entry itself — Dispatch Board remains visible to Sales/Booking per §5.1.6, just with fields redacted).

### 5.3.12 Global Loading, Error & Empty States

Distinct from the *component-level* states already defined in §5.2.5 — these are shell-level, whole-region states:

| State | Treatment |
|---|---|
| **App boot / initial load** | Full-page centered logo mark (icon-only) with a subtle pulse animation — no generic spinner, reinforces brand even during the one moment there's no content to show yet |
| **Route-level content loading** | Main content area shows the page-header skeleton (title bar shimmer) + a content skeleton matching the target screen's dominant pattern (table skeleton for list screens, card-block skeleton for detail screens) — sidebar/top bar remain fully interactive throughout, never blocked by content loading |
| **Route-level error** (data fetch failed) | Main content area shows a centered error state: icon + "Something went wrong loading this page" + "Retry" button — sidebar/top bar remain functional so the user isn't stuck |
| **Permission-denied route** | Distinct from the above — centered lock icon + "You don't have access to this page" (no retry button, since retrying won't change a permission outcome) — this is the shell-level counterpart to the component-level permission-denied state in §5.2.5 |
| **Network/connectivity loss** | A persistent top-of-content banner (`warning` alert variant, §5.2.5) — "Connection lost — retrying…" — rather than a full-page takeover, since the user may still be able to read already-loaded content |
| **Empty organization state** (theoretical — a brand-new org with zero customers/carriers/loads) | Dashboard shows a "Getting started" empty state guiding the Admin toward the first real actions (Invite your team, Add a Customer, Add a Carrier) rather than a bare empty dashboard — flagged as a UX judgment call in §5.6 since no workflow explicitly specifies onboarding-empty-state content |

---

### 5.3.13 Open Items Flagged (not resolved)

1. **No self-service profile editing** (§5.3.4) — omitted because no workflow defines it, not because it was decided against. Worth a deliberate call before Stage 7.
2. **No "mark all notifications read" bulk action** (§5.3.7) — same reasoning; small, easy to add later.
3. **New-organization empty-state / onboarding guidance content** (§5.3.12) — a reasonable UX default, not a locked business requirement.

None of these block finishing the shell — they're additive, non-breaking refinements that don't touch any locked workflow.

---

**Section 5.3 (Application Shell) — 🔒 LOCKED**, including the three explicitly-unresolved items (self-service profile editing, "mark all read," new-organization empty-state content) which remain unresolved — not invented here or later without a workflow/product decision behind them.

---

## 5.4 Critical Screen Designs

Critical-screen-first approach, per your direction — designed and locked one at a time.

| # | Screen | Status |
|---|---|---|
| 5.4.1 | Dispatch Board — Table View | 🔒 LOCKED |
| 5.4.2 | Dispatch Board — Kanban View | 🔒 LOCKED |
| 5.4.3 | Dispatch Board — Calendar View | 🔒 LOCKED |
| 5.4.4 | Load Detail | 🔒 LOCKED |
| 5.4.5 | Customer Detail | 🔒 LOCKED |
| 5.4.6 | Carrier Detail | 🔒 LOCKED |
| 5.4.7 | Invoice Detail / Invoice Builder | 🔒 LOCKED |
| 5.4.8 | Load Closing | Drafted below, pending review |

---

### 5.4.1 Dispatch Board — Table View

**Purpose**
The primary day-to-day operational workspace — where Dispatchers and Operations manage the active load portfolio: see what needs attention, filter down to relevant subsets, and take the next action on a load without leaving the list.

**Primary Users / Roles**
Dispatcher (primary daily user), Operations Manager & Admin (oversight, same capabilities as Dispatcher plus org-wide default scope), Sales/Booking (view + create, no dispatch actions), Accounting (view-only, full financial visibility).

**Entry Points**
- Sidebar: `Loads → Dispatch Board` (default sub-view when entering "Loads")
- Global search "See all results" for a load-related query
- Drawer's "Open Full Detail" does *not* return here — that goes to Load Detail (§5.4.4); the Board itself is a destination, not a waypoint

**Page Layout**
```
[Breadcrumb: Loads › Dispatch Board]
[Title: Dispatch Board]     [Table | Kanban | Calendar]     [+ New Load]

[My Loads ▾/All Loads]  [🔍 Search]  [Status ▾] [Customer ▾] [Carrier ▾]
[Dispatcher ▾] [Equipment ▾] [Pickup date ▾] [Delivery date ▾] [Risk ▾]  [Saved Views ▾]

[Pickups next 4h (3)] [Deliveries next 4h (5)] [Today (12)] [Overdue (1)]   ← quick-filter chips

┌─────────────────────────────────────────────────────────────────────┐
│ ☐ │ Load # │ Customer │ Status │ Risk │ Carrier │ Dispatcher │ ... │ ⋮ │
├─────────────────────────────────────────────────────────────────────┤
│  rows...                                                              │
└─────────────────────────────────────────────────────────────────────┘
[Showing 1–50 of 214]                                    [25/50/100 ▾]
```
A **bulk action bar** replaces the quick-filter-chip row when ≥1 row is checked (see below), then reverts on deselect.

**Information Hierarchy**
Status and Risk are leftmost and most visually prominent (badges, per §5.2.1) since "what state is this in and does it need attention" is the first question a Dispatcher asks. Identifying info (Load #, Customer) follows, then operational detail (Carrier, Dispatcher, dates, lane, equipment), with financial data — permission-gated — rightmost, since it's reference information for this screen's primary (Dispatcher) audience, not the primary decision driver.

**Components Used**
Segmented control (view switch, §5.1.4/5.3), toolbar search input (§5.2.5 in-page search), filter dropdowns (single/multi-select per field), date-range picker, Saved Views dropdown (draws on the saved-view capability already locked in PRD §9 Reporting), quick-filter chip row, Table (§5.2.5), Status/Risk badges (§5.2.1), row checkboxes + bulk action bar, kebab row menu, Drawer (§5.2.5/5.3 — row click), Pagination (§5.2.5), Primary button, Empty/Loading/Error states (§5.2.5, §5.3.12).

**Table Columns** (left to right)

| Column | Format | Notes |
|---|---|---|
| ☐ | Checkbox | Selection for bulk actions |
| Load # | `text-body-medium`, link | Opens Drawer on click (row click = same action) |
| Customer | Text | |
| Status | Badge (§5.2.1 Load.status mapping) | |
| Risk | Badge, blank if `NORMAL` | Maps to PRD's "Exception status" column — implemented via `risk_status`, the only V1 field for this, since formal stop-level Exceptions are deferred (Workflow 6 §6.10) |
| Carrier | Text, "—" if unassigned | |
| Dispatcher | Avatar + name, "Unassigned" chip if null | |
| Origin → Destination | `City, ST → City, ST` | From first pickup / last delivery stop |
| Pickup Date | Date, `warning` text color if within 4h and not yet Arrived | |
| Delivery Date | Date, same treatment | |
| Equipment | Text (Dry Van/Reefer/Flatbed) | |
| Customer Rate | Currency, right-aligned | **Hidden entirely for Dispatcher.** For Sales/Booking, shown only on rows where they are Account Owner or (fallback) creator — otherwise cell renders "—" |
| Carrier Rate | Currency, right-aligned | Same visibility rule as Customer Rate |
| Margin | Currency + %, right-aligned | Same visibility rule; additionally never shown to Sales/Booking even on their own deals unless explicitly permitted — **flagged as Open UX Decision #1** below, since PRD §7 says Sales sees "their own profitability information where permitted" without confirming margin specifically vs. just revenue |
| ⋮ | Icon button | Row menu: Open Full Detail, Assign Dispatcher, Reassign Dispatcher |

**Default Scope by Role**
| Role | Default Filter |
|---|---|
| Dispatcher | "My Loads" (`assigned_dispatcher_id = self`), toggle available to "All Loads" (view permission extends org-wide per §5.1.6) |
| Admin / Operations Manager | "All Loads," org-wide |
| Sales/Booking | "My Deals" (Account Owner, fallback creator — §5.1.7), toggle to "All Loads" (operational columns only — see financial redaction above) |
| Accounting | "All Loads" (this screen is secondary for Accounting; Billing is their primary workspace) |

**Status Scope:** Default filter **excludes `CLOSED`** loads — the Dispatch Board is the *active* operational view; closed loads are reachable via Load Search (§5.1.4/§5.1.5), which explicitly covers "all loads including closed." This preserves the IA distinction already locked in §5.1, not a new rule.

**Filters / Search / Sorting**
- Filters (multi-select where sensible): Status, Customer, Carrier, Dispatcher, Equipment, Pickup Date (range), Delivery Date (range), Risk — this is the exact field list from PRD's Dispatch Board requirement, plus Risk (the PRD's "Exception status").
- Search: matches Load #, Customer name, Carrier name, Origin/Destination text.
- Sortable columns: Load #, Pickup Date, Delivery Date (click column header, per §5.2.5's table spec).
- Saved Views: save the current filter combination with a name (e.g., "Loads at Risk — My Loads," directly from the PRD's own example), reapply from the dropdown.

**Primary & Secondary Actions**
- **Primary:** `+ New Load` → opens a small choice modal: "Start a Quote" vs. "Book Directly" (Workflow 4 §4.1's entry-path selection), routing to the respective creation flow.
- **Secondary:** `Export` (CSV/Excel, respects current filters, per PRD's Load Search export capability — available here too since the Board is filter-driven the same way).
- **Bulk action bar** (appears on row selection): `Assign Dispatcher`, `Assign Carrier`, `Export Selected` — deliberately **excludes a generic "Update Status" bulk action**. Reasoning: Workflow 6 locks Load status from `DISPATCHED` onward as *derived* from Stop progress, not manually settable, and pre-dispatch transitions (`BOOKED → CARRIER_SOURCING`, etc.) are meaningful single-load actions tied to specific per-load context (entering sourcing, confirming a rate) rather than a safe bulk operation. A generic bulk status dropdown would silently conflict with those locked state-machine rules, so it's intentionally omitted rather than included and caveated. Financially sensitive actions (rate changes, invoicing) are correctly excluded per the PRD's own "financially sensitive actions should NOT be casually bulk-editable" rule.
- Bulk `Assign Carrier`: each selected Load is still individually validated against the Workflow 5 §5.3 Assignment Eligibility hard gate at confirmation — bulk selection is a convenience for applying the *same* eligible carrier to multiple compatible loads, never a bypass of the per-load eligibility check.
- Every bulk action writes the same audit trail entries as its single-load equivalent (per PRD's bulk-action audit requirement).

**Status / State Behavior**
Status and Risk badges render exactly per the §5.2.1 mapping table. A load with `risk_status ≠ NORMAL` also gets a subtle `warning`/`danger`-tinted left border on its table row (1px, matching the badge's semantic color) so at-risk loads are scannable even without reading the Risk column directly — supports the "fast scanning" requirement.

**Permission-Aware Behavior**
- Column-level: financial columns (§ table above) do not render at all for Dispatcher (consistent with §5.3.11's hide-not-disable principle applied at the column level, not just navigation).
- Row-level: Sales/Booking sees all rows operationally but financial cells are redacted per-row based on Account Owner/creator (§5.1.7).
- Action-level: `Assign Carrier`, `Assign Dispatcher`, and row-menu dispatch actions are hidden (not disabled) for Sales/Booking and Accounting, matching their "view + create, no dispatch actions" / "view-only" designations in §5.1.3.

**Loading / Empty / Error States**
- Loading: table skeleton (§5.3.12), toolbar/filters remain interactive immediately (they don't depend on data being loaded).
- Empty (filters applied, no matches): "No loads match your filters" + `Clear filters` button (§5.2.5 empty-state pattern).
- Empty (zero loads exist org-wide — a brand-new organization): part of the new-organization empty-state question left explicitly unresolved in §5.3.13 — this screen inherits that same open item rather than inventing its own version of it.
- Error: centered retry state (§5.3.12), filters/toolbar remain usable so the user can try a narrower query.

**Important Interactions**
- Row click (anywhere except checkbox/kebab) → opens the Load Drawer (quick summary + context-sensitive next action, e.g., "Begin Carrier Sourcing" for a `BOOKED` load, "Generate Rate Confirmation" for `CARRIER_ASSIGNED`) + "Open Full Detail →" link to Load Detail (§5.4.4).
- Quick-filter chips are shortcuts that set the underlying date/risk filters — clicking "Overdue" is equivalent to manually filtering Delivery Date < today AND Status not in (DELIVERED, CLOSED); chips show a live count.
- Checkbox click does not trigger the Drawer (event isolation, standard table-selection UX).

**Relevant Workflow References**
Workflow 4 (§4.1 entry-path choice for "+ New Load"), Workflow 5 (§5.3 eligibility gate respected in bulk Assign Carrier), Workflow 6 (§6.6 derived status — why there's no bulk status action; §6.8 risk status), Workflow 1 (dispatcher reassignment audit pattern, reused here for bulk Assign Dispatcher).

**Desktop Viewport Considerations**
At the 1280px minimum: Load #, Customer, Status, Risk, Carrier, Dispatcher, and the date columns are the priority set; Origin/Destination, Equipment, and the financial columns (where visible) scroll horizontally within the table's own scroll container (sticky header, per §5.2.5) rather than the page reflowing. Above ~1600px, all columns for a given role fit without horizontal scroll. The row-selection checkbox and Load # columns are frozen (don't scroll horizontally) so context is never lost while scrolling right to see financial columns.

---

### 5.4.1 Resolutions — 🔒 LOCKED

1. **Sales/Booking Margin visibility:** Sales/Booking may see customer/revenue information for their own deals (Account Owner, fallback creator), but **Margin, carrier cost, and other internal profitability metrics remain hidden from Sales/Booking entirely**, regardless of ownership. Admin/Operations Manager org-wide visibility is unchanged.
2. **`pod_status`:** Confirmed off the default Table View column set. Available on Load Detail and Load Closing. May be offered as an optional/toggleable column if column customization is ever built — not part of the V1 default.

**Section 5.4.1 (Dispatch Board — Table View) — 🔒 LOCKED**, including: no generic bulk Update Status action, `CLOSED` excluded from the default active view, bulk Assign Carrier enforcing the full Workflow 5 eligibility gate per load, Dispatcher financial columns fully absent, and Sales/Booking financial visibility restricted per ownership and now further restricted to exclude Margin.

---

### 5.4.2 Dispatch Board — Kanban View

**Purpose**
The same active-load population as the Table View (§5.4.1), visualized by status column so a Dispatcher/Manager can see the shape of the whole operational pipeline at a glance — how many loads are stuck in Sourcing, how many are ready to dispatch, etc. — and move a load forward where that's actually a valid manual action.

**Primary Users / Roles**
Identical to Table View (§5.4.1): Dispatcher (primary), Operations Manager & Admin (oversight), Sales/Booking (view only, no drag actions), Accounting (view only).

**Entry Points**
Sidebar `Loads → Dispatch Board`, then the `Kanban` segment of the same view-switch control used in §5.4.1 — this is a **view of the same underlying filtered load set**, not a separate screen with its own URL-level identity beyond the `?view=kanban` query param already established in §5.1.4's sitemap.

**Page Layout**
```
[Breadcrumb: Loads › Dispatch Board]
[Title: Dispatch Board]     [Table | Kanban | Calendar]     [+ New Load]

[My Loads ▾/All Loads]  [🔍 Search]  [Status ▾] [Customer ▾] [Carrier ▾]
[Dispatcher ▾] [Equipment ▾] [Pickup date ▾] [Delivery date ▾] [Risk ▾]  [Saved Views ▾]
                                                          [Show Closed ▾ off]

┌──────────┬──────────────┬──────────────┬──────────────┬──────────┬─────────┬────────────┬───────────┐
│ Booked(4)│ Carrier      │ Carrier      │ Rate         │Dispatched│ Pickup  │ In Transit │ Delivered │
│          │ Sourcing (7) │ Assigned (2) │ Confirmation │   (5)    │  (3)    │    (6)     │    (9)    │
│          │              │              │    (1)       │          │         │            │           │
├──────────┼──────────────┼──────────────┼──────────────┼──────────┼─────────┼────────────┼───────────┤
│ [card]   │ [card]       │ [card]       │ [card]       │ [card]   │ [card]  │ [card]     │ [card]    │
│ [card]   │ [card]       │              │              │ [card]   │         │ [card]     │ [card]    │
│  ...     │  ...         │              │              │  ...     │         │  ...       │  ...      │
└──────────┴──────────────┴──────────────┴──────────────┴──────────┴─────────┴────────────┴───────────┘
```
Columns scroll horizontally as a whole board (the entire column set is wider than most viewports at full column count — see §Desktop Viewport Considerations); each column's card list scrolls vertically and independently once it exceeds the visible height.

**Column Set — LOCKED to the actual state machine, not the PRD's illustrative example**
The PRD's original Dispatch Board description used an illustrative, abbreviated column example (`Booked, Carrier Sourcing, Carrier Assigned, Dispatched, Pickup, In Transit, Delivered, Exception`) written before Stage 2 locked the full 9-value `Load.status` state machine (Workflows 4–6, 10). This screen uses the **authoritative** column set instead: `BOOKED, CARRIER_SOURCING, CARRIER_ASSIGNED, RATE_CONFIRMATION, DISPATCHED, PICKUP, IN_TRANSIT, DELIVERED` — eight columns by default. There is **no separate "Exception" column** — per the same reasoning already locked in §5.4.1's Risk column, formal stop-level Exceptions are deferred, and `risk_status` is the V1 proxy, shown as a per-card indicator (below), not a pseudo-status column that doesn't exist in the locked state machine.

**`CLOSED` is excluded by default**, consistent with §5.4.1's locked "Dispatch Board = active work" scope — a `Show Closed` toggle in the toolbar adds it as a ninth column when explicitly enabled, rather than cluttering the default board.

**Card Anatomy**
| Element | Notes |
|---|---|
| Left edge accent | 3px bar, `warning`/`danger` tint if `risk_status ≠ NORMAL`, otherwise no accent (matches the Table row-border pattern from §5.4.1) |
| Load # | `text-body-medium`, top line |
| Customer name | `text-small`, `neutral-500` |
| Carrier | Chip/tag, "Unassigned" in `neutral-400` if null |
| Dispatcher | Small avatar, bottom-right corner |
| Key date | The single most relevant date for that column's stage — Pickup Date for Booked/Sourcing/Assigned/Rate Confirmation/Dispatched/Pickup columns, Delivery Date for In Transit/Delivered columns; `warning`-colored text if within the next 4 hours and not yet actual-recorded |
| Equipment | Small icon (Lucide truck-type icon per §5.2.4), tooltip on hover |

**No financial figures on cards** (Customer Rate, Carrier Rate, Margin) — a card-density/scannability decision, not a locked requirement one way or the other. Financial detail remains a Table View / Drawer / Load Detail concern. **Flagged as Open UX Decision #1** below since it's a real design call, not something the source documents mandate.

**Filters / Search / Sorting**
Identical filter set to Table View (§5.4.1) — Status filter here acts as a column-visibility toggle rather than a row filter (selecting specific statuses shows only those columns). Same Saved Views, same My Loads/All Loads/My Deals scope rules per role. Cards within each column sort by the column's key date, soonest first — a default worth confirming (**Open UX Decision #2**).

**Primary & Secondary Actions**
- **Primary:** `+ New Load`, identical to Table View.
- **Secondary:** `Export` — exports the currently visible card set in the same flattened format as Table View's export, since "kanban" isn't a meaningful export shape.
- No bulk action bar in Kanban — multi-select doesn't have an established interaction pattern in a card-board layout, and every bulk action available in Table View remains reachable there. Kanban's manipulation model is drag-and-drop (below), not checkbox selection.

**Drag-and-Drop — the central design question for this screen**

The PRD calls for "status changes through drag-and-drop... where permissions allow." Read literally against the *locked* state machine, a plain drag-to-change-status interaction would contradict Workflow 6's rule that status from `DISPATCHED` onward is **derived** from Stop progress, not directly settable — the same conflict already resolved for Table View's bulk actions in §5.4.1. Kanban resolves it per-transition instead of omitting the interaction entirely, since a board's whole purpose is spatial movement:

| Drag From → To | Behavior |
|---|---|
| `BOOKED → CARRIER_SOURCING` | **Direct transition** — this is a pure status flip with no additional required data (Workflow 5 §5.1's "Begin Carrier Sourcing" action). Card moves immediately; toast confirms. |
| `CARRIER_SOURCING → CARRIER_ASSIGNED` | **Assisted** — dropping opens the Carrier Assignment flow (carrier picker + rate entry + live eligibility check, Workflow 5 §5.3–5.4) in a modal. Card does not move until that flow completes successfully; cancelling snaps the card back. |
| `CARRIER_ASSIGNED → RATE_CONFIRMATION` | **Assisted** — dropping opens the Rate Confirmation generation flow (Workflow 5 §5.7). Card moves on successful generation. |
| `CARRIER_ASSIGNED → CARRIER_SOURCING` (backward) | **Assisted** — represents a carrier rejection; dropping opens the required-reason modal (Workflow 5 §5.6). Card moves + a new Carrier Sourcing Attempt record is created on confirmation. |
| `RATE_CONFIRMATION → DISPATCHED` | **Assisted** — dropping opens the Dispatch flow (driver/truck/trailer capture + explicit "Dispatch Load" action, Workflow 6 §6.1). Card moves only on successful dispatch. |
| **Any drag into `PICKUP`, `IN_TRANSIT`, or `DELIVERED`** | **Blocked.** These are system-derived from Stop-level arrival/departure recording (Workflow 6 §6.6) and are never directly settable by any user action, drag included. Attempting the drop snaps the card back with an inline message: *"This status advances automatically as pickup/delivery stops are recorded — open the load to update stop status."* with a link into Load Detail's stop tracking. |
| **Any drag into `CLOSED`** | **Blocked** the same way — Closing requires the full readiness-checklist review (Workflow 10), not a bare status flip. Drop snaps back with a link to open the Load Closing screen (§5.4.8) instead. |
| **Dragging a card that is already in `DISPATCHED`, `PICKUP`, or `IN_TRANSIT`** | Cards in these columns are **not drag-sources** at all (no valid manual transition exists out of them per the locked state machine) — attempting to pick one up shows a brief "not draggable" cursor state rather than allowing a drag that has nowhere valid to land. |

This table is the concrete, workflow-consistent interpretation of the PRD's "where permissions allow" language — permission is necessary but not sufficient; the underlying state machine is the other gate, and both are enforced together.

**Permission-Aware Behavior**
- Only roles with dispatch-action permissions in Table View (Admin, Operations Manager, Dispatcher) can drag cards at all. Sales/Booking and Accounting see the board read-only — cards are not draggable for them (same "not draggable" cursor state as the terminal columns above), consistent with their "view-only, no dispatch actions" designation.
- Column visibility itself is not permission-restricted (everyone who can see the Dispatch Board sees all status columns) — only the *interaction* (dragging) is role-gated, matching how Table View hides actions but not data structure.
- Financial redaction is moot here since no financial figures appear on cards at all (see Card Anatomy).

**Loading / Empty / Error States**
- Loading: skeleton columns with 2–3 skeleton cards each (§5.3.12 pattern extended to the board layout).
- Empty column: a column with zero matching cards shows a muted "No loads" placeholder within that column rather than collapsing the column away — keeps the pipeline shape visually consistent even when a stage is temporarily empty.
- Empty board (all columns empty — filters too narrow, or a brand-new org): same "No loads match your filters" / new-org-empty-state handling as Table View (§5.4.1, and the still-open item from §5.3.13).
- Error: same centered retry pattern as Table View: applies to the whole board, not per-column.

**Important Interactions**
- Clicking a card (not dragging) opens the same Load Drawer used in Table View (§5.4.1) — consistent quick-preview behavior regardless of which view the user is in.
- Column header shows a live count badge (`text-caption`, `neutral-100` pill) — matches the count-badge treatment already established for tab labels (§5.2.5) and quick-filter chips (§5.4.1).
- Drag affordance: card shows a grab cursor on hover (only for draggable cards, per the permission/state rules above); a dragged card shows a `shadow-lg` elevated state while in motion, and valid drop-target columns highlight with a `brand-50` background while a drag is in progress, so users see *before* dropping which columns will actually accept the card.

**Relevant Workflow References**
Workflow 5 (§5.1, §5.3, §5.4, §5.6, §5.7 — nearly every drag transition maps directly to a specific sub-section), Workflow 6 (§6.1 dispatch flow, §6.6 derived-status rule underlying the blocked drops), Workflow 10 (Load Closing gate underlying the blocked drop into `CLOSED`).

**Desktop Viewport Considerations**
At 8 default columns (9 with Closed shown), the board exceeds 1280px width at any reasonable per-column width (~280px × 8 = 2240px) — the board is **intentionally a horizontally-scrolling region** distinct from the page itself (page-level layout stays fixed; only the column track scrolls), rather than compressing columns to fit, since compressed Kanban columns become unusably narrow for card content. A subtle scroll-shadow on the left/right edges indicates more columns exist off-screen. This is treated as expected/normal for this view (unlike Table View, where horizontal scroll was a fallback for narrow viewports) — Kanban boards conventionally scroll horizontally even on large monitors once there are enough columns.

---

### 5.4.2 Resolutions — 🔒 LOCKED

1. No financial figures on Kanban cards by default, including for Admin/Accounting — a UX density decision, not a change to financial permissions (full detail remains available on Load Detail).
2. Default card sort: soonest relevant operational date/time ascending (next applicable pickup/stop date-time), so the most immediately actionable loads surface first.
3. New-organization empty state remains an explicitly open item, inherited from §5.3.13 — not resolved here.

**Section 5.4.2 (Dispatch Board — Kanban View) — 🔒 LOCKED**, including: direct drag only for `BOOKED → CARRIER_SOURCING`, assisted drag (opens the actual required flow) for every transition needing additional locked-workflow data, and blocked direct drops into `PICKUP`/`IN_TRANSIT`/`DELIVERED`/`CLOSED`.

---

### 5.4.3 Dispatch Board — Calendar View

**Purpose**
A time-based view of **appointments** (scheduled pickup/delivery stop times), for spotting scheduling conflicts, gaps, and the day/week's shape at a glance — distinct from Table (status/data-dense list) and Kanban (pipeline/stage progress). Per PRD: day/week views only — **no month view** in V1 (explicitly not a "sophisticated scheduling engine").

**Primary Users / Roles**
Same as Table/Kanban (§5.4.1/§5.4.2): Dispatcher (primary), Operations Manager & Admin (oversight), Sales/Booking & Accounting (view-only).

**Entry Points**
Sidebar `Loads → Dispatch Board`, `Calendar` segment of the same view-switch control (§5.4.1/§5.4.2) — same underlying filtered load set, third visualization of it.

**Page Layout**
```
[Breadcrumb: Loads › Dispatch Board]
[Title: Dispatch Board]     [Table | Kanban | Calendar]     [+ New Load]

[My Loads ▾/All Loads]  [🔍 Search]  [Customer ▾] [Carrier ▾] [Dispatcher ▾]
[Equipment ▾] [Risk ▾]  [Saved Views ▾]

[‹ Today ›]   [Aug 11 – Aug 17, 2026]                    [Day | Week]

┌────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐
│  Time  │   Mon   │   Tue   │   Wed   │   Thu   │   Fri   │   Sat   │   Sun   │
├────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
│ 6:00a  │         │[event]  │         │         │         │         │         │
│ 7:00a  │[event]  │         │         │[event]  │         │         │         │
│  ...   │  ...    │  ...    │  ...    │  ...    │  ...    │  ...    │  ...    │
└────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘

[▸ Unscheduled Stops (3)]   ← collapsible panel, stops with no appointment_datetime set
```

**Events Are Stop-Level, Not Load-Level**
A multi-stop Load produces one calendar event **per Stop** with a set `appointment_datetime` (e.g., a load with 2 pickups + 1 delivery places 3 separate entries on the calendar, each at its own time/location) — this follows directly from the PRD's "display loads based on pickup and delivery appointments" and the locked multi-stop data model (`Stop.appointment_datetime`), rather than collapsing a load to a single calendar entry that would lose per-stop scheduling detail.

**Event Card Anatomy**
| Element | Notes |
|---|---|
| Left color bar | `Stop.status` mapping, reusing the exact §5.2.1 tokens: `PENDING`=neutral, `ARRIVED`=brand, `COMPLETED`=success — plus `danger` override if `appointment_datetime` has passed and status is still `PENDING` (an overdue appointment) |
| Stop type icon | Small Lucide icon: outbound arrow for Pickup, inbound arrow for Delivery — event *type* is shown via icon, not color, keeping color reserved for status (avoids a second competing color dimension) |
| Time | Appointment time, e.g. "8:00 AM" |
| Load # | `text-body-medium` |
| Location | City/State or `CustomerLocation` name if the stop reused one |
| Carrier | Small text, "Unassigned" if null |

**No financial figures on calendar events**, consistent with the density decision just locked for Kanban (§5.4.2) — same reasoning applied here, not a separate new decision.

**Unscheduled Stops Panel**
Stops that exist but have no `appointment_datetime` set yet cannot be placed on the time grid — rather than silently omitting them (a real gap the PRD's "display loads based on appointments" language doesn't address), they're listed in a collapsible panel below the grid so they're never invisible to a Dispatcher trying to get a complete picture of what needs scheduling.

**Filters / Search / Sorting**
Same filter set as Table/Kanban minus a Status filter (this view organizes by time, not pipeline stage) — Customer, Carrier, Dispatcher, Equipment, Risk, plus the same My Loads/All Loads/My Deals scope rules and Saved Views. Search behaves identically (Load #/Customer/Carrier/location).

**Primary & Secondary Actions**
- **Primary:** `+ New Load`, identical to Table/Kanban.
- **Secondary:** `Export` — exports the visible date range's stop/appointment list.
- Navigation: `‹ Today ›` (previous/next period), a `Today` shortcut, and the `Day | Week` toggle (PRD-locked view set — no Month option, intentionally).

**Status / State Behavior**
Status is represented at the **Stop** level (per event card), not the Load level, since that's what a calendar fundamentally organizes by. The overdue-and-still-pending `danger` override is the one place this view surfaces urgency proactively, similar in spirit to the "Overdue" quick-filter chip in Table View (§5.4.1) but expressed visually rather than as a filter chip.

**Permission-Aware Behavior**
Identical role rules to Table/Kanban: Sales/Booking and Accounting can view but not drag/edit (see interaction note below); scope defaults (My Loads / All Loads / My Deals) match §5.4.1's table exactly, applied to which stops populate the grid.

**Loading / Empty / Error States**
- Loading: skeleton time-grid with placeholder event blocks (§5.3.12 pattern).
- Empty (no appointments in the visible range matching filters): centered "No appointments scheduled for this period" message within the grid area, rather than a blank grid with no explanation.
- Error: same centered retry pattern as Table/Kanban.

**Important Interactions**
- Clicking an event opens the same Load Drawer used in Table/Kanban (§5.4.1/§5.4.2) — consistent quick-preview regardless of which of the three views the user is in.
- **Drag-to-reschedule (proposed, not locked — see Open UX Decision #1 below).** Dragging an event to a different time/day would update that Stop's `appointment_datetime`. Unlike the Kanban drag rules (§5.4.2), this doesn't conflict with any locked state-machine transition — `appointment_datetime` isn't part of the `Load.status`/`Stop.status` state machine, it's just a schedulable field — but the PRD's Calendar requirement only specifies *display* ("day/week views"), not editing, so I'm proposing this rather than asserting it as required. See below.

**Relevant Workflow References**
Workflow 6 (§6.3 Stop status model, §6.4 actual-vs-appointment distinction — appointment time is a separate concept from actual arrival, which is exactly why a calendar of *appointments* is a meaningfully different view from a calendar of *actuals*), locked multi-stop support (PRD §Load Structure) underlying the one-event-per-stop design.

**Desktop Viewport Considerations**
Week view at 7 day-columns + a time gutter is the tightest fit of the three Dispatch Board views at the 1280px minimum — each day column gets roughly ~150px, enough for 2–3 stacked event cards at a given hour before needing a "+2 more" overflow indicator (click to expand that hour slot). Day view has no such constraint (single column, full width) and is the recommended default for viewports at the lower end of the desktop range, with Week as the default at larger widths — **flagged as Open UX Decision #2** below since the source documents don't specify a default.

---

### 5.4.3 Resolutions — 🔒 LOCKED

1. **Drag-to-reschedule is interactive and locked in.** Dragging a Stop to a new date/time updates `Stop.appointment_datetime` only — never `Stop.status` or `Load.status` directly. Runs normal field validation, writes an `AuditLog` entry (previous datetime, new datetime, acting user), and respects the user's permission to edit that stop (Admin, Operations Manager, Dispatcher — not Sales/Booking or Accounting, consistent with their view-only designation elsewhere on the Dispatch Board).
2. **Default view: Week.** Manual toggle to Day remains available; no viewport-based auto-switching.
3. New-organization empty state remains explicitly open, inherited from §5.3.13.

**Section 5.4.3 (Dispatch Board — Calendar View) — 🔒 LOCKED**, including: stop-level events, icon (not color) for Pickup/Delivery type, `Stop.status`-driven event color with the overdue/pending danger override, the Unscheduled Stops panel, and no financial figures on events.

**This completes all three Dispatch Board views (5.4.1–5.4.3).**

---

### 5.4.4 Load Detail

**Purpose**
The single-load operational hub — the "coherent view of the complete lifecycle" screen. Every workflow from Booking through Closing (Workflows 4–10) touches this screen in some form; it's where a user goes to both *understand* a load's full history and *act* on its next required step.

**Primary Users / Roles**
All five internal roles land here, with very different action sets: Dispatcher and Operations Manager/Admin do the most acting (sourcing, dispatch, tracking); Sales/Booking and Accounting mostly observe, with Accounting acting specifically in the Financials tab.

**Entry Points**
Load # click from Table View, card click from Kanban, event click from Calendar (all via the Drawer's "Open Full Detail →" link — §5.4.1–5.4.3), Global Search result, Invoice/Carrier Payment detail screens (back-reference), Customer/Carrier Detail's "Loads" tab (§5.4.5/§5.4.6, not yet designed but referenced for consistency).

**Page Layout**
```
[Breadcrumb: Loads › LOAD-000456]
[LOAD-000456]              [Status: IN_TRANSIT] [Risk: AT RISK] [POD: PARTIAL]
                                          [Secondary ▾] [Primary Action Button]

[●───●───●───●───●───●───●───●───○]  ← Status stepper (Booked → Closed), current stage filled
  Booked  Sourcing  Assigned  RateConf  Dispatched  Pickup  Transit  Delivered  Closed

[Overview] [Stops & Tracking] [Carrier & Dispatch] [Documents] [Financials] [Activity History]
──────────────────────────────────────────────────────────────────────────
  (tab content area)
```

**Context-Sensitive Primary Action**
The header's Primary Action button changes with `Load.status`, directly reflecting the next locked-workflow step — this is the mechanism that makes "coherent view of the complete lifecycle" concrete rather than just a label:

| `Load.status` | Primary Action | Workflow |
|---|---|---|
| `BOOKED` | Begin Carrier Sourcing | 5 §5.1 |
| `CARRIER_SOURCING` | Assign Carrier | 5 §5.3–5.4 |
| `CARRIER_ASSIGNED` | Generate Rate Confirmation | 5 §5.7 |
| `RATE_CONFIRMATION` | Dispatch Load | 6 §6.1 |
| `DISPATCHED` / `PICKUP` / `IN_TRANSIT` | Record Stop Arrival/Departure (targets the next actionable `PENDING`/`ARRIVED` stop) | 6 §6.4–6.5 |
| `DELIVERED` | Contextual — see priority order below | 7, 8, 9, 10 |
| `CLOSED` | *(none — see note)* | 10 |

At `DELIVERED`, four independent next-actions become possible (Upload POD, Create Invoice, Initiate Carrier Pay, Close Load) and no locked workflow specifies which one deserves the single header button. Proposed priority — **flagged as Open UX Decision #1**: POD (if `pod_status ≠ COMPLETE`) → Create Invoice (if none exists) → Initiate Carrier Pay (if none exists) → Close Load (once the others are addressed or acknowledged). At `CLOSED`, there is intentionally no primary button — Workflow 10 established `CLOSED` as a milestone with no "next" step; only secondary actions (Add Payment, Upload Document, etc.) remain available, per §5.4.4's post-close editing rules below.

**Status Stepper**
Visualizes all 9 `Load.status` values as a horizontal progress track, filled up to the current stage. This is purely informational (not interactive/clickable — clicking a future stage does nothing, since stages can't be skipped per the locked state machine) and gives the "where is this load in its life" answer at a glance before reading anything else.

---

#### Tab: Overview (default)

**Purpose:** A condensed summary of every other tab, so most questions about a load can be answered without further clicking.

**Layout:** Two-column card grid.
| Left column | Right column |
|---|---|
| Customer & Lane card (customer name/link, origin→destination, equipment, reference numbers) | Carrier & Dispatch snapshot card (carrier name/link, driver/truck/trailer, or "Not yet assigned/dispatched") |
| Stops mini-timeline (compact version of the Stops tab — sequence, type, status dot, time) | Financial Summary card (permission-gated — see below) |
| Risk/At-Risk banner (only rendered if `risk_status ≠ NORMAL`, using the `warning`/`danger` alert component from §5.2.5) | Closing Readiness mini-checklist (Rate Confirmation / POD / Invoice / Carrier Pay — same Clean/Warning language as Workflow 10 §10.1, with a "Close Load →" link to the full Load Closing screen, §5.4.8, rather than an inline close action here) |

**Financial Summary Card — Permission Behavior:** Fully absent for Dispatcher. Shows Customer Rate only (no Margin/Carrier Rate) for Sales/Booking on non-owned loads; full Customer Rate + Margin for Sales/Booking on their own deals (per §5.4.1's locked resolution) *except* Margin remains hidden even then (§5.4.1 Resolution 1 — Margin is never shown to Sales/Booking, ownership notwithstanding). Full detail (Customer Rate, Carrier Rate, Gross Profit, Margin %) for Admin, Operations Manager, Accounting.

---

#### Tab: Stops & Tracking

**Purpose:** Full stop-by-stop detail and the manual tracking tools (Check Calls, Risk Status) from Workflow 6.

**Stop Table**
| Column | Notes |
|---|---|
| Seq | Sequence order |
| Type | Pickup/Delivery/Other badge |
| Location | Address or linked `CustomerLocation` name |
| Scheduled Appointment | `appointment_datetime` |
| Actual Arrival | Editable — "Record Arrival" action if `PENDING` |
| Actual Departure | Editable — "Record Departure" action if `ARRIVED` |
| Status | Badge (`PENDING`/`ARRIVED`/`COMPLETED`, §5.2.1) |

Stops can have arrival/departure recorded in any order the user encounters them — the locked workflows don't enforce strict sequence-locking on data entry, only on the *derived Load-level status* (first pickup `ARRIVED` → `PICKUP`; **all** pickup stops `COMPLETED` → `IN_TRANSIT`; the **final** delivery stop specifically — by sequence, not "any"/"all" — `COMPLETED` → `DELIVERED`, per Workflow 6 §6.6's precise wording). The UI computes and displays which specific stop is "next expected" as a subtle highlight, but never blocks recording a different stop out of order.

**Check Call Timeline**
Reverse-chronological list below the stop table: datetime, contact method, person contacted, location, ETA, on-time status, notes (Workflow 6 §6.7 fields exactly). "Log Check Call" button, enabled only when `Load.status ∈ {DISPATCHED, PICKUP, IN_TRANSIT}` — disabled (not hidden — this is a status-gate, not a permission-gate) with a tooltip explaining why otherwise.

**Risk Status Control**
Inline control (segmented buttons or select): Normal / At Risk / Delayed, with a required reason field that appears when selecting anything other than Normal (Workflow 6 §6.8). Same status-gate as Check Calls (`DISPATCHED` onward).

**Permission-Aware Behavior:** Recording arrival/departure, logging check calls, and setting risk status are available to Admin, Operations Manager, Dispatcher only — Sales/Booking and Accounting see this entire tab read-only (fields render, but no edit affordances/buttons appear at all, consistent with the hide-not-disable-for-permission principle from §5.3.11; the status-gate disabling above is a *different*, allowed case — disabled-with-explanation is used for temporary/status-based unavailability, not permission absence).

---

#### Tab: Carrier & Dispatch

**Purpose:** Everything related to Workflow 5 (sourcing/assignment/rate confirmation) and Workflow 6's dispatch snapshot.

**Carrier Sourcing Attempts Table** — full permanent history (Workflow 5 §5.5–5.6), never overwritten: Carrier, Rate Quoted, Outcome badge (`ASSIGNED`/`DECLINED`/`NO_RESPONSE`/`QUOTED`/`REJECTED_AFTER_ASSIGNMENT`), Reason (for rejections/declines), Logged By, Logged At. This table is the audit-friendly record of "who did we try, and what happened" — shown in full even after a load moves past sourcing, since Workflow 5 explicitly requires preserving every attempt.

**Current Assignment Card:** Carrier (link to Carrier Detail, §5.4.6), Carrier Rate, assignment date — only rendered once a carrier is actually assigned (`CARRIER_ASSIGNED` or later).

**Rate Confirmation Card:** Document status ("Not yet generated" / linked PDF with version), "Generate Rate Confirmation" action (enabled once Carrier + Carrier Rate are set, per Workflow 5 §5.7 — explicitly *not* gated on driver/truck/trailer), "Send via Email" action once generated (reuses the transactional email capability).

**Dispatch Record Card:** Driver name/phone, truck #, trailer #, dispatched by/at — rendered once `DISPATCHED` or later. "Edit" action available post-dispatch (Workflow 6 §6.9): editing updates the current values and writes an `AuditLog` entry with the previous values, never silently overwriting history.

**Permission-Aware Behavior:** Sourcing/assignment/rate-confirmation/dispatch actions: Admin, Operations Manager, Dispatcher only (matches Workflow 5/6's locked action permissions exactly). Sales/Booking and Accounting view this tab read-only.

---

#### Tab: Documents

**Purpose:** Every document associated with this Load or its Stops (Rate Confirmation, BOL, POD per delivery stop, lumper/scale/accessorial receipts, photos), using the universal polymorphic Document system (Architecture §8, Decision 3).

**Layout:** Two grouped tables.
1. **Load-Level Documents** (Rate Confirmation, BOL, receipts, photos, other) — Type, File, Version, Uploaded By/At, scan status.
2. **POD by Delivery Stop** — one row per delivery Stop showing that stop's POD status (`NOT_RECEIVED`/uploaded) with an upload action per stop (Workflow 7 §7.1) — this is what actually drives the Overview tab's `pod_status` badge (`NOT_RECEIVED`/`PARTIAL`/`COMPLETE`, derived per Workflow 7 §7.2, never directly settable here).

**Upload Behavior:** Standard upload flow (select type, select associated stop for POD, upload) → `scan_status = PENDING` → async malware scan → `CLEAN` before the file becomes downloadable (Architecture Decision 10) — a document row shows a small "Scanning…" indicator until `CLEAN`, and `INFECTED`/`SCAN_FAILED` files show a blocked/quarantined state with no download option.

**No review-status UI on this tab** — `review_status` (`PENDING_REVIEW`/`APPROVED`/`REJECTED`) only applies to Carrier compliance document types (Workflow 3), which live on Carrier Detail (§5.4.6), not here; Load-level document types are `NOT_APPLICABLE` for review per the Stage 4 schema, so no approve/reject UI renders on this tab at all.

**Permission-Aware Behavior:** Upload available to the same roles as elsewhere in the app (document permission = entity access, per PRD's document-visibility rule) — in practice, any role that can view this Load can upload a document to it, since no workflow restricts Load-document upload by role the way Carrier compliance upload is scoped.

---

#### Tab: Financials

**Purpose:** Charge line items, invoicing status, and carrier pay status — Accounting's primary reason to visit this screen.

**Charge Line Items Table** — two grouped sections (Customer side / Carrier side), each: Type, Description, Qty, Unit Rate, Amount, Source (`ORIGINAL`/`ADJUSTMENT`). **"Add Charge" button** — per the newly-locked Stage 4 Decision D9, available to Admin, Operations Manager, Dispatcher, and Accounting, with no approval step, fully audited. This is the concrete UI for that decision.

**Gross Profit / Margin** — computed at read-time (Architecture §10), shown as a summary row beneath the two charge tables. Permission behavior identical to the Overview tab's Financial Summary card.

**Customer Invoice Card:** status badge, invoice number (link to Invoice Detail, §5.4.7), or "Not yet invoiced" + "Create Invoice" action (enabled once `Load.status ≥ DELIVERED`, per Workflow 8 §8.1's eligibility rule, with the POD-incomplete warning dialog from Workflow 8 §8.2 if applicable).

**Carrier Payment Card:** list of `CarrierPayment` records (a load can have several — deposit/partial/balance/adjustment, Workflow 9 §9.7) each with status badge and amount, remaining carrier balance computed live, "Add Carrier Payment" action (enabled once `Load.status ≥ DELIVERED`).

**Permission-Aware Behavior:** This entire tab is **hidden** (not just field-redacted) for Dispatcher, consistent with §5.4.1's "financial columns fully absent" principle extended to a whole tab. Sales/Booking sees it with the ownership+no-margin redaction rules already locked. Accounting and Admin/Operations Manager see full detail and all actions.

---

#### Tab: Activity History

**Purpose:** A single chronological record combining Communication Activity, Internal Notes, and system Audit Log entries for this load — "what happened and who did it," in one place.

**Layout:** Reverse-chronological timeline, each entry typed and visually distinguished (icon + subtle left-color): system audit events (neutral), internal notes (brand-tinted), logged communications (info-tinted). Filter chips to isolate one type. "Add Internal Note" and "Log Communication Activity" actions at the top (per the PRD's Dispatch communication-logging requirement).

**⚠️ Cross-Cutting Design Requirement — Financial Redaction in Audit Entries:** Some `AuditLog` entries for this load (e.g., `Carrier Assigned`, `Rate Changed During Conversion`) carry rate/financial figures inside their JSONB `previous_value`/`new_value` payload. This timeline **must apply the same field-level redaction rules as the Financials tab** when rendering those entries for a Dispatcher or non-owning Sales/Booking user — e.g., a `Carrier Assigned` entry renders as *"Carrier Assigned: ABC Trucking"* for a Dispatcher, without the rate figure that a full audit view would show an Accounting user. This is a real leak vector I'm flagging proactively (not an invented business rule — it's the direct, correct application of the already-locked "Dispatcher never sees financial data" rule to a screen that could otherwise defeat it) — **flagged as Open UX Decision #2** to confirm this redaction approach rather than assume the underlying audit data model change is trivial.

**Permission-Aware Behavior:** Visible to all roles (subject to the redaction above) — no workflow restricts *visibility* of activity history by role, only the financial content within specific entries.

---

### Screen-Level: Loading / Empty / Error States

- **Loading:** Header/stepper skeleton + active tab's content skeleton (table or card-block, per §5.3.12), other tabs' content loads lazily on first visit rather than all six tabs fetching simultaneously.
- **Empty states per tab:** "No check calls logged yet," "No documents uploaded yet" + Upload action, "No charges added yet" + Add Charge action, "No activity yet" (rare — creation itself always produces at least one audit entry, so this is effectively unreachable but included for completeness).
- **Error:** Tab-scoped retry (a failure loading Financials doesn't take down Stops & Tracking) — each tab's content area has its own error boundary.
- **Permission-denied tabs** (Financials for Dispatcher): the tab doesn't appear at all in the tab list, per the hide-not-disable rule — there's no "denied" state to design because the entry point doesn't exist.

### Important Interactions
- Status stepper and tab navigation are independent — switching tabs never changes the load's actual status; only the action buttons within tabs (or the header's primary action) do.
- Every primary action button (Assign Carrier, Generate Rate Confirmation, Dispatch Load, etc.) opens the same modal/flow already specified in the Kanban view's assisted-drag table (§5.4.2) — **one implementation, two entry points** (drag-drop from Kanban, button click from Load Detail), not two separate flows to maintain.
- "Close Load →" navigates to the dedicated Load Closing screen (§5.4.8) rather than closing inline — keeps that screen meaningful as its own destination per your critical-screen list, and keeps Load Detail from becoming even more overloaded.

### Relevant Workflow References
This screen is the composite of Workflows 4 (booking info shown on Overview), 5 (Carrier & Dispatch tab in full), 6 (Stops & Tracking tab, dispatch snapshot), 7 (Documents tab's POD section, `pod_status` derivation), 8 (Financials tab's Invoice card), 9 (Financials tab's Carrier Payment card), 10 (Overview's Closing Readiness card, linking out to §5.4.8) — essentially every locked workflow except 1–3 (Org/User, Customer, Carrier creation, which are their own screens).

### Desktop Viewport Considerations
Two-column Overview grid collapses to a single stacked column below ~1440px (still ≥1280px minimum) rather than compressing card widths unreadably. Tables within tabs (Stops, Sourcing Attempts, Charge Line Items) follow the same frozen-first-column + horizontal-scroll pattern established for the Dispatch Board Table View (§5.4.1).

---

### 5.4.4 Resolutions — 🔒 LOCKED

1. **Primary action at `DELIVERED`:** `Create Customer Invoice` (or `View Customer Invoice` if one already exists). POD remains visible via Documents/the `pod_status` milestone; Carrier Pay remains available via the Financials tab; Close remains available via the Closing action/checklist — none of these are implied prerequisites for the others beyond what's already locked.
2. **Audit-history financial redaction:** confirmed. Dispatcher never sees restricted rate/cost/margin/profitability/invoice/carrier-pay amounts anywhere, including inside Activity History entries; Sales/Booking follows the existing own-deal rule and never sees internal profitability. Redaction happens at the presentation/API authorization layer only — the underlying `AuditLog` record is never altered or deleted, remaining complete for authorized/compliance use.

**Section 5.4.4 (Load Detail) — 🔒 LOCKED**, including the six-tab structure, lifecycle stepper, context-sensitive primary actions, the fully-hidden Financials tab for Dispatcher, and the D9 Add Charge behavior.

---

### 5.4.5 Customer Detail

**Purpose**
The customer master-data hub: manage the record itself (contacts, locations, rate agreements, status, payment terms) and see everything tied to this customer (loads, invoices) without leaving the record.

**Primary Users / Roles**
Sales/Booking (primary owner of the relationship), Admin & Operations Manager (full access), Accounting (payment terms, rate agreements, invoices), Dispatcher (view-only, no create/edit — matches Workflow 2's creation-permission list exactly excluding Dispatcher).

**Entry Points**
`/customers` list, Load Detail's Customer & Lane card (§5.4.4), Global Search, Quote/Load creation's customer picker "view" affordance.

**Page Layout**
```
[Breadcrumb: Customers › ABC Manufacturing]
[ABC Manufacturing]                    [Status: ACTIVE]
                          [Edit ▾] [+ New Quote]

[Overview] [Contacts] [Locations] [Rate Agreements] [Loads] [Invoices]
────────────────────────────────────────────────────────────────────
  (tab content area)
```
Tab set is exactly the one already locked in the §5.1.4 sitemap — no new tabs introduced here.

**Customer Status Badge — extends §5.2.1**
Not previously enumerated in the Design System's status table; added here for consistency with the existing `Carrier.status` pattern (same four-shape status set, same treatment): `PROSPECT`=neutral, `ACTIVE`=success, `INACTIVE`=neutral, `BLOCKED`=danger. Prospect and Inactive intentionally share the neutral color — they're distinguished by badge text, consistent with the design system's "never color-only" rule (§5.2.6/accessibility).

**Header Actions**
- **Primary: `+ New Quote`** — opens the same Quote-vs-Direct-Booking choice used on the Dispatch Board (§5.4.1, Workflow 4 §4.1), pre-filled with this customer. Visible only to roles with Quote/Load creation permission (Admin, Sales/Booking, Operations Manager, Dispatcher, per Workflow 4 §1 — **Accounting is excluded here**, not because of financial visibility but because Accounting simply isn't a creator role in Workflow 4). Status-gated per Workflow 4 §4.3: **disabled** (not hidden — this is a status-gate, same convention used in Load Detail) with an explanatory tooltip when `Customer.status = BLOCKED`; remains clickable but surfaces the Workflow 4-defined warning/override step when `INACTIVE`; unrestricted for `PROSPECT`/`ACTIVE`.
- **Secondary: `Edit`** (opens the master-data edit form — legal name, billing address, primary contact, payment terms override) and, via a menu, **`Change Status`** (Prospect/Active/Inactive/Blocked — per Workflow 2 §2.3/§2.8, this is an unrestricted authorized-user action with no approval workflow, since none was locked). Both available to Admin, Sales/Booking, Operations Manager, Accounting — **not Dispatcher**.
- No duplicate-detection UI appears on Edit — per Workflow 2 §2.2, that check is explicitly a **creation-time-only** behavior; the Detail screen's edit form doesn't re-run it.

---

#### Tab: Overview

Customer Info card (legal name, billing address, primary contact — the Workflow 2 §2.1 required fields), Status + Account Owner (with an "Assign Owner" action if unset, per Workflow 2 §2.1's "optional at creation, assignable later"), Payment Terms card (current value + `Inherited`/`Override` source badge, per Workflow 2's locked inheritance rule), and a snapshot stats row (# Loads, # Active Rate Agreements — both simple counts, no financial figures here, financial totals live on the Invoices tab where they're permission-appropriate).

---

#### Tab: Contacts

Table of `CustomerContact`: Name, Email, Phone, Role badge (`Booking`/`Operations`/`Billing`/`Management`/`Other`), Primary flag. `Add Contact` action; row-level Edit/Remove — ordinary master-data editing, audited like any other change (Workflow 2 §10), not a specially-restricted action.

---

#### Tab: Locations

Table of `CustomerLocation`: Name, Type badge (`Pickup`/`Delivery`/`Other`), Address, Contact, Operating Hours. `Add Location` action — these become selectable during Load/Quote stop creation (Workflow 2's "reusable when creating loads" requirement).

---

#### Tab: Rate Agreements

Table of `CustomerRateAgreement`: Origin, Destination, Equipment, Rate, Rate Type, Effective/Expiration dates, and a computed `Active`/`Expired` badge (derived from today vs. the date range — display-only, doesn't affect any workflow gate itself). `Add Rate Agreement` action. Deliberately simple, per the PRD's explicit "basic functionality first, not a sophisticated rate engine" — no matching/preview UI here; the actual matching happens at Quote/Load creation time (Workflow 4 §4.4), not on this screen.

**Hidden entirely for Dispatcher** — rate agreements are pricing information, and this tab is treated with the same financial-visibility principle as the rest of the app.

---

#### Tab: Loads

Reuses the Dispatch Board Table View's exact column set, filters, and role-based financial-column rules (§5.4.1), scoped to `customer_id` (Customer filter removed as redundant). Same "hide, don't blank" rule for Dispatcher's financial columns.

---

#### Tab: Invoices

Table of `Invoice` records for this customer: Invoice #, Status badge, Total, Due Date, Balance — link to Invoice Detail (§5.4.7). **Hidden entirely for Dispatcher.** For Sales/Booking, follows the same own-deal visibility rule as elsewhere (§5.1.7/§5.4.1): full amounts for invoices tied to their own loads (Account Owner, fallback creator), status-only (no amounts) for others. Full detail for Admin, Operations Manager, Accounting.

---

### Permission Summary (Customer Detail)

| Action/Tab | Admin | Ops Manager | Dispatcher | Sales/Booking | Accounting |
|---|---|---|---|---|---|
| View Overview/Contacts/Locations/Loads | ✅ | ✅ | ✅ (view-only) | ✅ | ✅ |
| View Rate Agreements / Invoices | ✅ | ✅ | **Hidden** | ✅ (own-deal redaction on Invoices) | ✅ |
| Edit / Change Status | ✅ | ✅ | ❌ | ✅ | ✅ |
| + New Quote | ✅ | ✅ | ✅ | ✅ | ❌ (not a creator role) |
| Add Contact/Location/Rate Agreement | ✅ | ✅ | ❌ | ✅ | ✅ |

### Loading / Empty / Error States
Same shell-level and per-tab patterns established in Load Detail (§5.4.4): tab-scoped skeletons/error boundaries, empty states per table ("No contacts yet" + Add Contact, "No rate agreements yet" + Add Rate Agreement, etc., §5.2.5 pattern).

### Important Interactions
Clicking a row in Loads/Invoices tabs navigates to Load Detail/Invoice Detail respectively (full navigation, not a Drawer — this is already a detail-level screen, so a further nested quick-preview would add a layer of indirection the Dispatch Board's list context doesn't have).

### Relevant Workflow References
Workflow 2 in full (creation fields, duplicate detection scoped to creation only, Prospect default, payment-term inheritance, no approval workflow, editability without retroactively changing historical transactions), Workflow 4 §4.3 (status gating on the New Quote action).

### Desktop Viewport Considerations
Same tab-content patterns as Load Detail (§5.4.4) — tables follow the frozen-first-column + horizontal-scroll convention from §5.4.1 at the 1280px minimum.

---

### 5.4.5 Resolutions — 🔒 LOCKED

1. Expired Rate Agreements: display-only in V1 — the `Expired` badge is informational, no automatic usage restriction beyond what's already locked.
2. Contact/Location removal: standard confirmation dialog only, no dependency-based blocking beyond the locked rules; removal is fully audit-logged like any other edit.

**Section 5.4.5 (Customer Detail) — 🔒 LOCKED**, including the six-tab structure from the §5.1.4 sitemap, the extended Customer status badge mapping, and the Accounting-excluded-from-New-Quote permission detail.

---

### 5.4.6 Carrier Detail

**Purpose**
The carrier master-data and **compliance/eligibility** hub — per your emphasis, this screen's central job is making a carrier's assignment eligibility (and exactly what's blocking it, if anything) immediately, unambiguously clear, since that's what a Dispatcher relies on before ever assigning this carrier to a load (Workflow 5 §5.3's hard gate).

**Primary Users / Roles**
Admin, Operations Manager, Dispatcher (creation/edit permission, per Workflow 3 §1); **Compliance Reviewer** — a distinct permission, not a creation-permission consequence (Workflow 3 §2), typically held by some subset of Admin/Operations Manager; Sales/Booking & Accounting (view-only, per §5.1.3).

**Entry Points**
`/carriers` list, Load Detail's Carrier & Dispatch tab (§5.4.4), the Compliance Review Queue (`/carriers/compliance-queue`, a separate cross-carrier screen not in this pass's critical-screen set — but it deep-links into this screen's Compliance tab for a specific document), Global Search.

**Page Layout**
```
[Breadcrumb: Carriers › ABC Trucking]
[ABC Trucking (DBA: ABC Express)]      [Status: ACTIVE]  [Eligibility: ✅ ELIGIBLE]
                              [Edit ▾] [Activate Carrier]*

[Overview] [Compliance] [Insurance] [Contacts] [Drivers] [Trucks] [Trailers] [Loads] [Factoring]
──────────────────────────────────────────────────────────────────────────────────
  (tab content area)
```
*`Activate Carrier` only renders while `status = PENDING`; disabled until all eligibility conditions are met (see below). Tab set matches the §5.1.4 sitemap exactly.

**Status vs. Eligibility — Two Separate, Equally Prominent Badges**
Per Workflow 3 §3.8's explicit rule ("keep Assignment Eligibility separate from Carrier Status"), these are **never merged into one badge**:
- **Status badge:** `PENDING`=neutral, `ACTIVE`=success, `INACTIVE`=neutral, `BLOCKED`=danger (§5.2.1, already locked).
- **Eligibility badge:** `success` "✅ Eligible" or `danger` "❌ Ineligible" — clicking/hovering an Ineligible badge opens a popover listing every failing reason from `Carrier.ineligibility_reasons`, in plain language (e.g., "Cargo insurance expired," "MC Authority not yet approved"). This directly satisfies Workflow 3's "system must make immediately clear... whether a carrier can be assigned."

**`Activate Carrier` Button**
Visible only to users holding the **Compliance Reviewer** permission, and only while `status = PENDING`. Disabled until all 7 eligibility conditions (Workflow 3 §3.8) are independently satisfied — the disabled state's tooltip lists exactly which remain unmet, reusing the same `ineligibility_reasons` data as the header badge. Per Workflow 3 §3.7, activation is **never automatic** — even once every condition is met, a Compliance Reviewer must take this explicit action; the button existing-but-disabled-until-ready is what makes that explicit-action requirement concrete in the UI.

---

#### Tab: Overview

**Carrier Info card:** Legal name, DBA, MC #, DOT #, address, primary contact.

**Eligibility Checklist card** — the compliance/eligibility centerpiece of this screen: all 7 conditions from Workflow 3 §3.8 listed as a checklist, each with a ✓/✗ and a link to the relevant tab:
1. Carrier Status = Active
2. Carrier Agreement = Approved *(→ Compliance tab)*
3. W9 = Approved *(→ Compliance tab)*
4. Auto Liability Insurance = Approved + not expired *(→ Insurance tab)*
5. Cargo Insurance = Approved + not expired *(→ Insurance tab)*
6. MC Authority = Approved *(→ Compliance tab)*
7. FMCSA/SAFER Verification = completed + acceptable *(→ Compliance tab)*

This card is functionally a rendering of the exact same eligibility-calculation logic from Workflow 3 §3.8 — not a separate, potentially-divergent summary; it always matches the header's Eligibility badge.

**Equipment Types** — shown as tags, **computed from this carrier's registered Trucks/Trailers** (distinct `truck_type`/`trailer_type` values currently marked `active`), not a separately stored field.

**Lane / Region Preferences** — shown as tags in a dedicated section (Lane tags formatted `Origin, ST → Destination, ST`; Region tags shown as their free-text label), sourced from the new `CarrierServiceArea` table (DATABASE_DESIGN.md §5, Decision Log **D16** — added as a Stage 4 addendum after this screen's design surfaced the gap). `Add Lane`/`Add Region` action, available to the same roles as other carrier master-data edits (Admin, Operations Manager, Dispatcher). Purely informational/filterable, per PRD §3.6's explicit scope limit — no automated matching against load lanes, and no effect on `assignment_eligible`.

---

#### Tab: Compliance

**Compliance Documents table:** one row per required type (`W9`, `Carrier Agreement`, `MC Authority`) plus any org-custom compliance types — Document status badge (`review_status`: `Pending Review`=warning, `Approved`=success, `Rejected`/`Expired`=danger), Uploaded By/At, Reviewed By/At, Expiration Date (where applicable). `Upload`/`Replace` action per row.

**Approve / Reject actions:** visible only to Compliance Reviewers, and — critically — **disabled with an explanatory tooltip ("You cannot review a document you uploaded") whenever the current user is that document's uploader**, regardless of holding the Compliance Reviewer permission (Workflow 3 §3.4's self-review prevention, enforced in the UI as well as the service layer). `Reject` opens a modal requiring a non-empty reason (Workflow 3 §3.4).

**FMCSA/SAFER Verification card** (placed on this tab — the sitemap didn't carve out a separate tab for it, and it's conceptually a compliance gate like the documents above): verification date, result/status, verified by, authority info, notes. `Record Verification` action, restricted to Compliance Reviewers (Workflow 3 §3.5's actor is specifically the Compliance Reviewer, not any onboarding user).

**Note on COI placement:** the Certificate of Insurance document itself is uploaded and reviewed from the **Insurance tab**, not this one — per Workflow 3's explicit clarification that COI is a supporting document for the structured Auto Liability/Cargo coverage records, kept there so the document and its coverage data stay visually together rather than split across two tabs.

---

#### Tab: Insurance

Two cards, **Auto Liability** and **Cargo** (both required for eligibility): Coverage Amount, Insurance Company, Agent Contact, Effective Date, Expiration Date — the expiration date rendered with `success`/`warning`/`danger` coloring matching the 30/15/7-day notification thresholds already locked in Workflow 3 §3.10, so the same urgency signal appears here as in the notification system. Linked COI document (with its own `review_status` badge and Approve/Reject actions, same self-review rule as the Compliance tab). `Add`/`Edit` action per coverage type.

---

#### Tab: Contacts
Same pattern as Customer Contacts (§5.4.5) — Name, Email, Phone, Role badge (`Dispatch`/`Safety-Compliance`/`Billing`/`Factoring`/`Management`/`Other`), Primary flag, Add/Edit/Remove (standard confirmation, fully audited — same resolution as §5.4.5).

---

#### Tab: Drivers / Trucks / Trailers *(three separate tabs, per the locked sitemap)*
Each a simple table of the lightweight reusable records from Workflow 3 §1–4: Drivers (Name, Phone, Email, License #, Active toggle); Trucks (Unit #, Type, Make/Model/Year, VIN, Plate, Active toggle); Trailers (Unit #, Type, VIN, Plate, Active toggle). `Add` action per tab. These are exactly the records that populate the searchable-combobox pickers on Load Detail's Dispatch flow (Workflow 6 §6.1, §5.2.5's combobox component) — inactive records are excluded from those pickers but remain visible/editable here.

---

#### Tab: Loads
Same Dispatch-Board-Table-View reuse pattern as Customer Detail's Loads tab (§5.4.5), scoped to `carrier_id`. Carrier Rate remains hidden from Dispatcher here too — inherited from §5.4.1, not a new decision.

---

#### Tab: Factoring
`CarrierFactoringInfo` fields: Uses Factoring toggle, Factoring Company, Remit-To Address, Factoring Contact, Payment Instructions, NOA Status + linked document. A persistent inline note on this tab: *"Factoring information is informational only in V1 and does not affect assignment eligibility"* — stated explicitly so the tab's presence doesn't imply it gates anything, consistent with Workflow 3 §3.11/§9.11.

---

### Permission Summary (Carrier Detail)

| Action/Tab | Admin | Ops Manager | Dispatcher | Sales/Booking | Accounting | Compliance Reviewer* |
|---|---|---|---|---|---|---|
| View all tabs | ✅ | ✅ | ✅ | ✅ (view-only) | ✅ (view-only) | ✅ |
| Edit master data / Add Contact/Driver/Truck/Trailer | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Upload compliance/insurance documents | ✅ | ✅ | ✅ | ❌ | ❌ | — |
| Approve/Reject documents, Record FMCSA Verification | Only if also holding Compliance Reviewer | Only if also holding Compliance Reviewer | Only if also holding Compliance Reviewer | ❌ | ❌ | ✅ (never on own uploads) |
| Activate Carrier | Only if also holding Compliance Reviewer | Only if also holding Compliance Reviewer | Only if also holding Compliance Reviewer | ❌ | ❌ | ✅ |

*Compliance Reviewer is a separately assignable role (per Stage 4's `MembershipRole` enum) — the table's right two columns aren't mutually exclusive with the others; a user can hold Admin *and* Compliance Reviewer simultaneously, per the locked multi-role model (Workflow 1 §7).

### Loading / Empty / Error States
Same conventions as Load/Customer Detail: tab-scoped skeletons and error boundaries; empty states per table ("No compliance documents uploaded yet," "No drivers added yet" + Add action, etc.).

### Important Interactions
Clicking the Eligibility badge (when Ineligible) opens the reasons popover without navigating away — the fastest path to "why can't I assign this carrier," answerable without leaving the header. Clicking a listed reason link jumps to the relevant tab.

### Relevant Workflow References
Workflow 3 in full — this screen is essentially its UI. §3.1–3.2 (creation, MC/DOT uniqueness — display only, since uniqueness is enforced at creation), §3.3–3.4 (document upload/review, self-review prevention), §3.5 (FMCSA), §3.6 (equipment — partially, per the flagged gap), §3.7 (activation), §3.8 (eligibility calculation — the Overview checklist), §3.9–3.10 (expiration handling/notifications — the Insurance tab's color-coded dates), §3.11 (factoring, informational-only), §3.12 (Blocked always ineligible, reflected in the eligibility badge regardless of other conditions).

### Desktop Viewport Considerations
Same patterns as Customer/Load Detail — tab tables follow the frozen-column + horizontal-scroll convention from §5.4.1.

---

### 5.4.6 Resolutions — 🔒 LOCKED

1. **Carrier lane/region preferences:** resolved, not deferred. `docs/DATABASE_DESIGN.md` patched with a new `CarrierServiceArea` table (Decision Log **D16**, a Stage 5 addendum) — minimal schema (LANE/REGION type, structured origin/destination or free-text label), no matching engine, no eligibility impact, consistent with existing RLS/tenant-isolation conventions. The Overview tab now displays real tag data instead of a placeholder.
2. **FMCSA Verification** stays on the Compliance tab — confirmed as UI placement only, no business-rule change.

**Section 5.4.6 (Carrier Detail) — 🔒 LOCKED**, including the Status/Eligibility badge separation, the Eligibility Checklist card mirroring Workflow 3 §3.8 exactly, self-review prevention on document approval, COI living on the Insurance tab, and the now-resolved Lane/Region Preferences section.

---

### 5.4.7 Invoice Detail / Invoice Builder

Two linked flows, designed together: the **Builder** (Ready-to-Invoice queue → Draft creation, Workflow 8 §8.1–8.5) produces the record that **Detail** (Draft management through Paid/Void, §8.6–8.12) then manages through its lifecycle.

**Primary Users / Roles**
Accounting and Admin only, for every action on both flows (Workflow 8's exact locked permission set) — Operations Manager has financial *visibility* parity elsewhere in the app (§5.1.7), but invoice actions specifically were never included in Operations Manager's permission list in Workflow 8, so Operations Manager gets **read-only** access here, same as the redacted-view pattern used for Sales/Booking (see Permission Summary below). **Dispatcher has no access at all** — nav-hidden, and a direct URL hits the shell-level permission-denied state (§5.3.12).

---

#### 5.4.7a Invoice Builder

**Entry Points:** `Billing → Customer Invoices → + New Invoice`, or the context-sensitive primary action on a `DELIVERED` Load (§5.4.4, now locked as `Create Customer Invoice`), or Customer Detail's Invoices tab (§5.4.5).

**Page Layout — Step 1: Select Loads**
```
[Breadcrumb: Billing › Customer Invoices › New Invoice]
[Select Loads to Invoice]

[Customer ▾ (required first)]   [🔍 Search]   [Date Delivered ▾]

┌───┬─────────┬──────────┬───────────────┬─────────────┬──────┐
│ ☐ │ Load #  │ Delivered│ Customer Chg. │ POD Status  │      │
├───┼─────────┼──────────┼───────────────┼─────────────┼──────┤
│ ☐ │LOAD-0456│ Aug 10   │ $2,450.00     │ ✅ Complete │      │
│ ☐ │LOAD-0461│ Aug 11   │ $1,800.00     │ ⚠ Partial   │      │
└───┴─────────┴──────────┴───────────────┴─────────────┴──────┘
                                    [Continue with 2 loads →]
```
- **Customer selection is required first** — the queue only populates once a customer is chosen, since consolidated invoicing requires a single customer (Workflow 8 §8.4) and this prevents building an invalid multi-customer selection from the start rather than validating it after the fact.
- Queue = Loads with status `DELIVERED` or later, `invoiced = false`, for the selected customer (Workflow 8 §8.1's eligibility rule exactly).
- Selecting exactly 1 load enables "Continue" toward an **Individual Invoice**; selecting 2+ enables **Consolidated Invoice** — both paths converge into the same Step 2/3 flow, just with different line-item population (§8.5).

**Step 2: POD Warning (conditional)**
If any selected load has `pod_status ∈ {NOT_RECEIVED, PARTIAL}`, the exact modal already locked in Workflow 8 §8.2 appears before proceeding: *"POD incomplete — This invoice contains a load with missing or incomplete POD documentation."* / Cancel / Proceed Anyway — "Proceed Anyway" is audited (`Invoice Created Despite Incomplete POD`).

**Step 3: Review & Build**
```
[Invoice Preview — ABC Manufacturing]

Individual (1 load):                    Consolidated (2+ loads):
┌──────────────────────────┐            ┌──────────────────────────┐
│ Linehaul        $2,200.00│            │ LOAD-0456       $2,450.00│
│ Fuel Surcharge    $150.00│            │ LOAD-0461       $1,800.00│
│ Detention          $100.00│           │                          │
└──────────────────────────┘            └──────────────────────────┘
                    Total: $2,450.00                  Total: $4,250.00
                                            [Save as Draft]
```
- Individual invoices show every `ChargeLineItem` from the load, editable before saving (Workflow 8 §8.3).
- Consolidated invoices show one line per load (load number + that load's total), full charge detail remaining on the source Load — clicking a line navigates into that Load's Financials tab (§5.4.4), not an inline expansion, keeping this screen from re-implementing that table.
- `Save as Draft` generates the invoice number immediately (Workflow 8 §8.7) and marks all included loads `invoiced = true`, removing them from the Ready-to-Invoice queue.

---

#### 5.4.7b Invoice Detail

**Entry Points:** Billing → Customer Invoices list, Load Detail's Financials tab, Customer Detail's Invoices tab, the Builder's own "Save as Draft" redirect.

**Page Layout**
```
[Breadcrumb: Billing › Customer Invoices › INV-000123]
[INV-000123]           [Status: PARTIALLY_PAID]  [⚠ Overdue — computed]
ABC Manufacturing                    [Void ▾]  [Add Adjustment]  [Record Payment]

[Line Items]                          [Summary]
┌──────────────────────────┐          Total:              $4,250.00
│ (per §8.5 shape above)    │          Payments Received:  −$2,000.00
└──────────────────────────┘          Adjustments:            $0.00
                                       Remaining Balance:    $2,250.00
[Payments]                            Due Date:          Aug 25, 2026
┌────────────────────────────────┐
│ Aug 15 · $2,000 · ACH · Ref#123│
└────────────────────────────────┘

[Adjustments]
┌────────────────────────────────┐
│ (empty — none yet)              │
└────────────────────────────────┘
```

**Header Status & Primary Action by State**
| `Invoice.status` | Header Badge | Primary Action |
|---|---|---|
| `DRAFT` | neutral | `Send Invoice` → opens a modal (recipient email pre-filled from the customer's primary/billing contact, subject, message, PDF attached) confirming both the `DRAFT → SENT` transition and the transactional email send together (Workflow 8 §8.6, reusing the PRD §10.1 email pattern) |
| `SENT` / `PARTIALLY_PAID` (+ computed `OVERDUE` overlay badge if applicable) | brand / warning / danger per §5.2.1 | `Record Payment` → amount, date, method, reference, notes (Workflow 8 §8.9) |
| `PAID` / `CREDITED` | success | *(none — view/export only)* |
| `VOID` | neutral, struck-through label | *(none)* |

**`Void`** (menu action, any pre-Void status): destructive confirmation dialog explicitly stating the consequence — *"Voiding this invoice will release its N load(s) back to the Ready-to-Invoice queue."* — since that's a real, easy-to-miss side effect (Workflow 8 §8.12).

**`Add Adjustment`** (available once `SENT` or later): modal — type (Credit/Debit), amount, reason (required), date. Writes a permanent `Adjustment` row; never rewrites the original line items or total (Workflow 8 §8.11's financial-integrity principle).

**Line Items, Payments, Adjustments tables** — straightforward tables matching the DATABASE_DESIGN.md fields exactly (no new columns invented): Payments show amount/date/method/reference/notes/recorded-by; Adjustments show type/amount/reason/date/created-by.

---

### Permission Summary (Invoice Builder & Detail)

| Role | Builder (create invoices) | Detail — View | Detail — Send/Record Payment/Adjust/Void |
|---|---|---|---|
| Admin | ✅ | ✅ | ✅ |
| Accounting | ✅ | ✅ | ✅ |
| Operations Manager | ❌ *(not a Workflow 8 actor — flagged below)* | ✅ (full amounts, per financial-visibility parity) | ❌ |
| Sales/Booking | ❌ | Own-deal invoices only (full amounts); non-owned invoices show status-only in Customer Detail's list, not independently linkable | ❌ |
| Dispatcher | ❌ | ❌ (nav-hidden; direct URL → permission-denied) | ❌ |

**⚠️ Flagged — Operations Manager and invoice actions:** §5.1.7 locked Operations Manager as having full financial-visibility parity with Admin, and Workflow 10 gives Operations Manager Load Closing permission — but Workflow 8 itself names only "Accounting and Admin" as invoice actors, never Operations Manager. I've built this screen honoring Workflow 8's literal actor list (view-only for Ops Manager) rather than extending it based on the general visibility-parity principle, since *visibility* and *action permission* are different things and only the former was explicitly locked for Operations Manager. **Open UX Decision #1** — confirm whether Operations Manager should also get invoice action permissions (Send/Record Payment/Adjust/Void), or if view-only is correct.

### Loading / Empty / Error States
Builder: empty Ready-to-Invoice queue shows "No eligible loads for this customer" (not a generic empty state — names the eligibility reason, since PRD's `DELIVERED`+`not yet invoiced` rule is exactly what's being checked). Detail: standard tab-free single-page skeleton/error patterns consistent with other detail screens.

### Important Interactions
Consolidated invoice line items link out to the source Load's Financials tab rather than expanding inline — keeps this screen from duplicating the Charge Line Item table UI a second time. The POD warning modal is byte-for-byte the same component instance used wherever else this exact Workflow 8 §8.2 behavior is needed (there's only one place it's needed — this flow — but it's built as the same reusable Alert-Modal component from §5.2.5, not a bespoke one-off).

### Relevant Workflow References
Workflow 8 in full — this is its direct UI realization, section by section as cited above.

### Desktop Viewport Considerations
Line item / Payments / Adjustments tables are narrow enough (≤6 columns each) to never require horizontal scroll even at the 1280px minimum, unlike the wider Dispatch Board/Stops tables elsewhere.

---

### 5.4.7 Resolution — 🔒 LOCKED

**Operations Manager:** view-only confirmed as correct, permanently — full financial visibility (can view invoice detail, all amounts) but no invoice actions (Send/Record Payment/Adjust/Void) unless Workflow 8 is explicitly amended to grant them. Workflow 8's literal actor list (Accounting, Admin) remains the sole source of truth for invoice *actions*; financial-visibility parity (§5.1.7) governs *viewing* only and is never extended to actions on its own.

**Section 5.4.7 (Invoice Detail / Invoice Builder) — 🔒 LOCKED**, including the Builder's customer-first two-path flow (Individual/Consolidated), the POD warning modal reuse, the Send/Record Payment/Void/Add Adjustment action set, and the Operations Manager view-only resolution above.

---

### 5.4.8 Load Closing

**Purpose**
The final, deliberate gate screen — presents the readiness checklist and executes the Close action as its own focused destination (not an inline Load Detail action), so closing is always a considered step rather than something that happens accidentally while scrolling a busy detail page.

**Primary Users / Roles**
Accounting, Admin, Operations Manager — Workflow 10's exact locked actor list. Dispatcher and Sales/Booking have no access; the entry point (Load Detail's "Close Load →" link) only renders for these three roles in the first place (hide-not-disable, consistent with every other role gate in this design).

**Entry Points**
Load Detail's Overview tab, Closing Readiness card (§5.4.4) — the only entry point designed in this pass. *(A "Ready to Close" filter on Load Search would be a natural companion, but wasn't part of the locked Load Search requirements — noted as a possible future enhancement, not built here.)*

**Page Layout**
```
[Breadcrumb: Loads › LOAD-000456 › Close Load]
[Close LOAD-000456]
ABC Manufacturing · Delivered Aug 10, 2026

┌─────────────────────────────────────────────────────────┐
│ ✅ Rate Confirmation        On file                       │
│                              [View Document]                │
├─────────────────────────────────────────────────────────┤
│ ⚠ POD                       Partial (1 of 2 stops)         │
│                              [View Documents]                │
├─────────────────────────────────────────────────────────┤
│ ✅ Customer Invoice          INV-000123 (Sent)              │
│                              [View Invoice]                  │
├─────────────────────────────────────────────────────────┤
│ ✅ Carrier Pay               $1,000 of $2,050 paid          │
│                              [View Payments]                 │
└─────────────────────────────────────────────────────────┘

⚠ This load has 1 item that isn't complete. You can still close it.

[Cancel]                                          [Close Load]
```

**Checklist Item Rendering** — exactly the four items and Clean/Warning states locked in Workflow 10 §10.1–§10.5, no additions:
| Item | Clean | Warning |
|---|---|---|
| Rate Confirmation | "On file" (green ✅) | "Missing" (amber ⚠) |
| POD | "Complete" (green ✅) | "Partial (X of Y stops)" or "Not Received" (amber ⚠) |
| Customer Invoice | "Exists" — shows invoice # + status, **regardless of paid status** (green ✅) | "Missing" (amber ⚠) |
| Carrier Pay | "Payment recorded" — shows amount paid of total, **regardless of full payoff** (green ✅) | "No payment recorded" (amber ⚠) |

Each item links to where it can actually be resolved (Rate Confirmation document, Documents tab, Invoice Detail, Financials tab) — so a user who decides *not* to close yet has an immediate path to fix what's missing instead of just being told about it.

**Close Action**
A single `Close Load` button, **always enabled** — per Workflow 10's explicit "never a hard blocker" rule, there is no disabled state here regardless of checklist content. **No secondary confirmation modal appears**, even when warnings are present — this is a deliberate choice, not an oversight: Workflow 10 §10.6 explicitly states the checklist view itself, combined with the explicit act of clicking a clearly-labeled `Close Load` button, **is** the required acknowledgment. Adding a second "Are you sure?" modal on top of that (the pattern used elsewhere for Void, Deactivate, etc.) would be inventing extra ceremony the workflow specifically didn't ask for — so this screen intentionally does *not* match those other destructive-confirmation patterns.

On click: transitions `Load.status → CLOSED`, writes the `Load Closed` audit event with the full checklist snapshot (Workflow 10 §10.7), shows a success toast, and returns the user to Load Detail — which now shows `CLOSED` in the header, the stepper fully filled, and the checklist snapshot available in Activity History.

**Already-Closed Handling**
If this screen is reached for a Load that's already `CLOSED` (e.g., a stale bookmark/link), it shows a simple "This load is already closed" state with a link back to Load Detail — no checklist, no Close button — since Workflow 10 defines no Reopen action and re-closing isn't meaningful.

**Permission-Aware Behavior**
Entry point hidden (not disabled) for Dispatcher/Sales/Booking, per role. A direct URL visit by an unauthorized role hits the shell-level permission-denied state (§5.3.12).

**Post-Close Note**
This screen's job ends at the Close action itself — everything about *what's still editable after closing* (documents, payments, adjustments all remaining available per Workflow 10 §10.8) is Load Detail's behavior, already specified in §5.4.4, not duplicated here.

### Loading / Empty / Error States
Loading: checklist skeleton (4 placeholder rows). Error: standard centered retry. No empty state applies (a load always has a checklist to show, even if every item is a warning).

### Important Interactions
Every checklist item's "View X" link opens the relevant Load Detail tab or external screen in the normal navigation flow (not a Drawer — this is already a focused, single-purpose screen, consistent with the same reasoning used for Customer/Carrier Detail's row-click behavior in §5.4.5).

### Relevant Workflow References
Workflow 10 in full — this screen is its direct, complete UI realization.

### Desktop Viewport Considerations
Single-column, fixed-width card (~640px, centered) — this screen has no tables or dense data, so it doesn't need to use the full workspace width; a focused, narrower layout reinforces that this is a deliberate, singular action rather than another data-browsing screen.

---

### 5.4.8 Resolution — 🔒 LOCKED

No new status restriction. Workflow 10 is preserved exactly: a Load can be closed any time it is not already `CLOSED`. The "Close Load →" entry point and this screen remain reachable and functional at any pre-`CLOSED` status — reaching it before `DELIVERED` simply shows more items as warnings (per the existing Clean/Warning rendering); the `Close Load` action remains unblocked, with the checklist + explicit click continuing to serve as the sole acknowledgment, no additional modal.

**Section 5.4.8 (Load Closing) — 🔒 LOCKED**, including the always-enabled Close button, no secondary confirmation modal, and the already-closed handling state.

**This completes all 8 screens in the critical-screen-first pass (5.4.1–5.4.8).**

---

## 5.5 Interaction / State Specifications

Cross-cutting behavior for the 8 locked screens — consolidating patterns already established per-screen into explicit, systematic rules, and catching gaps that per-screen design didn't surface. Where something below is new (not previously stated), it's marked as a **recommendation**, not a restated lock.

### 5.5.1 Loading States

Every screen's initial load uses a **skeleton matching its dominant content shape** — never a bare spinner for page/region-level loading (§5.3.12, §5.2.5):
- Table-shaped screens (Dispatch Board Table, any tab containing a table): skeleton rows at the real row height.
- Kanban: skeleton columns with 2–3 skeleton cards each (§5.4.2).
- Calendar: skeleton time-grid with placeholder event blocks (§5.4.3).
- Detail screens (Load/Customer/Carrier Detail): header/stepper skeleton + the **active tab only** loads first; other tabs fetch lazily on first visit, each with its own skeleton (§5.4.4) — avoids six simultaneous requests when a user only wants Overview.
- Focused single-purpose screens (Load Closing): a 4-row checklist skeleton.
- Spinners are reserved for buttons and other small, isolated actions (e.g., a submit button mid-request) — never for a whole page/region.

### 5.5.2 Empty States

Three recurring variants, used consistently everywhere a list/table can be empty (formalizing what was applied ad hoc per-screen):
| Variant | Example | Treatment |
|---|---|---|
| **Zero records exist at all** (new/unused relationship) | A new Carrier with no compliance documents yet | Icon + "No [X] yet" + primary CTA to create the first one (§5.2.5 empty-state pattern) |
| **Zero records match current filters** | Dispatch Board filtered to a Customer with no active loads | "No [X] match your filters" + `Clear Filters` action, not a creation CTA |
| **Zero records org-wide** (brand-new organization) | A first-time Admin's empty Dispatch Board | **Still an open item** — inherited from §5.3.13/§5.4.1, not resolved by this section either |

### 5.5.3 Error States

- **Field-level:** inline, `danger-600` border + message below the field (§5.2.5).
- **Region/tab-level:** each tab on a detail screen has its own error boundary (§5.4.4) — a Financials-tab load failure never takes down Stops & Tracking.
- **Page-level:** centered icon + message + `Retry` (§5.3.12).
- **Permission-denied:** visually distinct from both of the above — lock icon, no `Retry` (retrying doesn't change a permission outcome) (§5.3.12, §5.4.8).
- **Network loss:** persistent top-of-content `warning` banner, not a full-page takeover (§5.3.12).
- **Action-submission failure** (new — not previously specified per-screen): if a modal/form submission fails server-side (e.g., a live re-validation catches something the client didn't — Workflow 5 §5.3's carrier-eligibility re-check at the moment of submission), the error renders **inline within that modal**, near the top or the specific offending field — the modal never silently closes or discards entered data on failure. If a standalone action fails with no further input needed to retry (e.g., approving a document and the self-review check rejects it because role state changed mid-session), a `danger` toast explains why and any optimistic UI change reverts.

### 5.5.4 Validation States

- Required fields marked with `*`; validation runs on blur (format checks — currency, date ordering) and on submit (completeness).
- **Submit buttons stay enabled**, never silently disabled while a form is incomplete — clicking with invalid/missing fields shows inline errors and focuses the first invalid field. (Recommendation: a disabled submit button gives no explanation of *what's* wrong; an enabled button that clearly points to the problem is more discoverable and is used consistently across every form in this design.)
- Reason-required fields (rejection reasons — Workflow 3 §3.4, Workflow 9 §9.4; loss reasons — Workflow 4 §4.6; adjustment reasons — Workflow 8 §8.11) render as required text areas with the same validation treatment — submission is blocked with an inline message if left empty, never silently allowed through.
- Currency fields reformat to 2 decimals on blur, matching the locked `DECIMAL(12,2)` standard (Architecture Decision 6) — what's displayed always matches what's stored.
- Cross-field validation (e.g., Stop actual departure not before actual arrival, Workflow 6 §6.5; Insurance expiration not before effective date, Workflow 3 §3.6) shows the error on the second (later) field, since that's the one the user just changed relative to the first.

### 5.5.5 Permission-Based Behavior

The single most-repeated rule across every screen — stated once, applied everywhere: **hide entirely for permission absence, disable-with-explanation for status/state gates.** These are different situations and use different treatments (§5.3.11):
- *Permission absence* (a role can never do this, period — e.g., Dispatcher and Billing, Sales/Booking and carrier sourcing actions): the control doesn't render at all. No tooltip, no disabled ghost button — nothing to accidentally imply access is one setting away.
- *Status/state gate* (any authorized role, but not right now — e.g., "Log Check Call" before `DISPATCHED`, "Activate Carrier" before all eligibility conditions are met): the control renders **disabled with a tooltip explaining exactly why**, since this is temporary and actionable information the user needs.

### 5.5.6 Success / Error Feedback

Two channels, chosen by whether the information needs to persist in view:
- **Toast** (top-right, 4s auto-dismiss + manual close, §5.2.5): discrete completed actions — "Invoice sent," "Carrier payment approved," "Load closed," "Rate Confirmation generated." The action is done; nothing more for the user to look at.
- **Inline alert banner** (stays in the page/modal until dismissed or resolved): warnings that remain relevant to the current view and may inform a decision still being made — POD-incomplete warning (Workflow 8 §8.2), Carrier ineligibility block (Workflow 5 §5.3), Load Closing checklist warnings (Workflow 10). A toast would disappear before the user finishes deciding what to do about it — the wrong channel for these.

### 5.5.7 Modal / Drawer Behavior

- **Drawer** = quick preview only (the Load Drawer, §5.4.1–5.4.3) — never contains a form requiring submission beyond simple contextual next-step buttons that themselves open a modal or navigate to a full screen. A Drawer is never the final step of a data-changing action.
- **Modal** = a focused, required decision or a self-contained task (reason-required rejections, the Carrier Assignment flow, the Dispatch flow, Send Invoice, Add Adjustment, Add Charge).
- **Backdrop-click dismissal:** allowed for pure-confirmation modals (Void, Deactivate); **blocked** for modals mid-way through required input (Reject Document/Payment, Carrier Assignment, Dispatch) so a stray click never discards typed data (§5.2.5, restated here as a systematic rule, not a one-off).
- **Escape key** (recommendation, not previously specified): always closes/cancels **any** modal or drawer, including the backdrop-blocked ones above — Escape is a deliberate, unambiguous user signal (unlike an accidental backdrop click), so it's always honored as "Cancel."
- No modal-from-drawer nesting occurs anywhere in this design — every assisted action (Kanban's assisted drags, §5.4.2) opens its modal directly, never through an intermediate Drawer.

### 5.5.8 Form Submission Behavior

- Submit button shows a loading spinner and disables **only during the in-flight request** (preventing double-submission), re-enabling immediately on success (before navigating away) or failure.
- On success: toast (§5.5.6) + modal closes / navigation proceeds.
- On failure: inline error (§5.5.3) + entered data is **always preserved**, never cleared — a failed submission should never cost the user their input.
- Multi-step flows (Invoice Builder's 3 steps, §5.4.7a; the Carrier Assignment/Dispatch assisted flows, §5.4.2/§5.4.4) preserve all prior steps' entries when navigating back, and re-validate on final submit rather than trusting earlier client-side checks alone (matching the "live re-validation at the moment of submission" pattern already locked for Carrier Assignment specifically, Workflow 5 §5.3).

### 5.5.9 State Transitions & Assisted Actions

Restating the general principle established concretely in §5.4.2 and applied throughout: **a transition that requires no additional data beyond the status change itself is a direct one-click action; a transition that requires additional locked-workflow data always opens its full flow** (modal or dedicated screen) rather than a bare status dropdown/toggle. This is why there's no generic "change status" control anywhere in this design (§5.4.1's explicit omission) — every transition is either trivially direct (`BOOKED → CARRIER_SOURCING`) or explicitly assisted (carrier assignment, rate confirmation, dispatch, activation), never a free-floating status picker that could desync from what the workflow actually requires.

### 5.5.10 Destructive / Irreversible Actions

Confirmation-dialog pattern (§5.2.5): Void Invoice, Deactivate User, Reject Document/Carrier Payment (reason required), Carrier Rejection (reason required) — Destructive button variant, button label restates the action ("Void Invoice," never bare "Confirm"), consequence stated explicitly in the dialog body (e.g., Void's "will release its N load(s) back to the Ready-to-Invoice queue," §5.4.7b).

**Load Closing is the one deliberate exception** (§5.4.8) — not because closing is unimportant, but because Workflow 10 explicitly built its own acknowledgment mechanism (the checklist + explicit labeled button) that supersedes the generic confirmation-modal pattern used everywhere else. This distinction is intentional and shouldn't be "fixed" into consistency with Void/Deactivate in a later stage without re-checking Workflow 10 first.

### 5.5.11 Table / Filter / Sort Behavior

- **Sort:** click a sortable column header to sort ascending; click again for descending; a third click returns to the table's default sort (usually the most operationally relevant date, ascending). *(Recommendation — not specified in any locked source; a standard, low-risk default.)*
- **Filter combination logic** (recommendation): filters combine with AND across different fields (Status + Customer + Carrier all narrow the result set together); multi-select values within one filter combine with OR (`Status = Booked or Dispatched`).
- **Filter persistence** (recommendation): active filters live in the URL query string, so back/forward navigation, bookmarking, and sharing a filtered view all work — this is also what Saved Views (§5.4.1) actually save.
- **Search:** in-page filter search is debounced (~300ms) and filters live as the user types, matching the "fast scanning" priority from the PRD's Dispatch Board requirement; Global Search (§5.3.6) is a separate, explicit-trigger overlay, not a live-filter of the current page.

### 5.5.12 Responsive Behavior (Within the Locked Desktop-First Scope)

Consolidating the per-screen rules already established, all governed by §5.3.9's 1280px minimum:
- Dispatch Board **Table**: frozen selection+Load# columns, remaining columns horizontal-scroll as a *fallback* at the minimum width (§5.4.1).
- Dispatch Board **Kanban**: horizontal column-track scroll is the *expected norm* at any width once there are enough columns, not a narrow-viewport fallback (§5.4.2) — the one place horizontal scroll isn't a compromise.
- Dispatch Board **Calendar**: week columns compress to ~150px before an hour slot shows a "+N more" overflow (§5.4.3).
- Detail screens (Load/Customer/Carrier): two-column card grids collapse to single-column below ~1440px, still within the supported desktop range (§5.4.4).
- Load Closing: intentionally fixed narrow width (~640px) regardless of viewport — the one screen that doesn't try to use available width, since it's a single deliberate action, not a data-browsing surface (§5.4.8).

### 5.5.13 Keyboard / Accessibility Behavior

Several of these are **new recommendations** surfaced while writing this section — not previously specified per-screen, and flagged as such:
- Tab order follows visual/DOM order: top bar → sidebar → page header → main content.
- Modals trap focus while open; focus returns to the triggering element on close (standard accessibility requirement, not previously stated).
- Escape closes any modal/drawer (§5.5.7).
- Global Search: `⌘K`/`Ctrl+K` (§5.3.6, already locked).
- Status badges are never color-only — text label always present (§5.2.5's "never color-only" rule) — this is what keeps color-blind users from losing information the rest of this spec leans on color heavily to convey.
- **⚠️ New recommendation, not yet built into any screen's spec above:** table row **kebab action menus must not be hover-only-to-reveal** — a purely hover-triggered affordance is unreachable by keyboard and screen-reader users. Recommend kebab triggers are always visible (or focus-visible at minimum), not opacity-0-until-hover.
- **⚠️ New recommendation:** the two **drag-and-drop interactions** in this design (Kanban card drags, §5.4.2; Calendar drag-to-reschedule, §5.4.3) have no specified keyboard-accessible alternative. Recommend: Kanban cards get a "Move to…" option in their context menu (kebab) as a keyboard/screen-reader-accessible equivalent to dragging; Calendar events get a "Reschedule" option opening a simple date/time form as the equivalent for drag-to-reschedule. Neither was built into the §5.4.2/§5.4.3 specs — flagged here as **Open UX Decision** rather than silently assumed into those already-locked sections.
- Color contrast (brand blue on white, semantic status colors) should meet WCAG AA at minimum — stated as a target/requirement here; actual contrast-ratio verification against final rendered values is a Stage 6/7 QA task, not something verifiable at the specification stage.

---

### Open UX Decisions Introduced in 5.5

1. **Keyboard-accessible alternatives to drag-and-drop** (§5.5.13) — Kanban card movement and Calendar rescheduling are currently mouse-drag-only in the locked 5.4.2/5.4.3 specs. Recommended fix (kebab "Move to…" / "Reschedule" options) is proposed but not yet applied to those sections — confirm whether to retrofit them now or track as a follow-up.

Everything else in 5.5 either restates an already-locked pattern precisely (traceable back to its originating section) or is marked inline as a low-risk UX recommendation with no business-rule content (sort/filter mechanics, focus trapping, etc.) — nothing here overrides or reinterprets a locked workflow.

---

*Section 5.5 (Interaction / State Specifications) drafted.*

---

## 5.6 UI/UX Decision Log

A complete index of every design decision point across Stage 5 (5.1–5.5), each marked 🔒 **LOCKED** (resolved, one-line summary + originating section) or 🔴 **OPEN** (still needs your decision, full detail below the index). Nothing in the LOCKED rows below reopens a prior decision — this section only indexes and consolidates.

### 5.6.1 Decision Index

| # | Section | Decision | Status |
|---|---|---|---|
| IA-1 | 5.1.1 | Two-tier structure: Platform console vs. Organization workspace | 🔒 LOCKED |
| IA-2 | 5.1.2 | Sidebar + top-bar app shell pattern | 🔒 LOCKED |
| IA-3 | 5.1.3–5.1.4 | 7-item primary nav + full sitemap | 🔒 LOCKED |
| IA-4 | 5.1.7 | Operations Manager: full financial-visibility parity with Admin | 🔒 LOCKED |
| IA-5 | 5.1.7 | Sales/Booking "own deals" = Account Owner, fallback creator | 🔒 LOCKED |
| IA-6 | 5.1.7 | Dispatch Board + Load Search combined under one "Loads" nav section | 🔒 LOCKED |
| DS-1 | 5.2.1 | Brand blue `#1A2BC3` usage restricted to interactive/brand elements only | 🔒 LOCKED |
| DS-2 | 5.2.1 | Full color token set + complete status-badge mapping (all locked enums) | 🔒 LOCKED |
| DS-3 | 5.2.2 | Inter typeface for UI; script wordmark restricted to logo asset only | 🔒 LOCKED |
| DS-4 | 5.2.3 | Spacing/radius/shadow scales | 🔒 LOCKED |
| DS-5 | 5.2.4 | Lucide icon set | 🔒 LOCKED |
| DS-6 | 5.2.5 | Full component specification (buttons → confirmation dialogs) | 🔒 LOCKED |
| DS-7 | 5.2.5 | Drawer component for quick Load preview (UX judgment call, accepted) | 🔒 LOCKED |
| SH-1 | 5.3.1 | Shell dimensions (240/64px sidebar, 56px top bar, 1280px minimum) | 🔒 LOCKED |
| SH-2 | 5.3.3 | Org switcher renders only for multi-membership users | 🔒 LOCKED |
| SH-3 | 5.3.5 | Universal page-header pattern (breadcrumb → title → badges → 1 primary action) | 🔒 LOCKED |
| SH-4 | 5.3.6 | Global search as `⌘K` command palette | 🔒 LOCKED |
| SH-5 | 5.3.7 | Notifications scoped to Workflow 3's compliance-expiration alerts only | 🔒 LOCKED |
| SH-6 | 5.3.8 | Sidebar collapse/expand with persisted preference | 🔒 LOCKED |
| SH-7 | 5.3.11 | Permission-aware nav: hide (not disable) for inaccessible sections | 🔒 LOCKED |
| SH-8 | 5.3.12 | Shell-level loading/error/permission-denied/network-loss states | 🔒 LOCKED |
| SH-9 | 5.3.4/5.3.13 | Self-service profile editing (name + password only; membership/roles/permissions stay admin-controlled) | 🔒 LOCKED |
| SH-10 | 5.3.7/5.3.13 | "Mark all read" notification action (UI convenience, no new notification types/rules) | 🔒 LOCKED |
| SH-11 | 5.3.12/5.3.13 | New-organization empty state: Dashboard-only "Getting Started" guide; all other screens use standard empty states | 🔒 LOCKED |
| DB-T-1 | 5.4.1 | Column set + full financial-column hiding for Dispatcher | 🔒 LOCKED |
| DB-T-2 | 5.4.1 | No generic bulk "Update Status" (state-machine conflict) | 🔒 LOCKED |
| DB-T-3 | 5.4.1 | `CLOSED` excluded from default Board scope | 🔒 LOCKED |
| DB-T-4 | 5.4.1 | Bulk Assign Carrier still enforces full per-load eligibility gate | 🔒 LOCKED |
| DB-T-5 | 5.4.1 | Sales/Booking never sees Margin, even on own deals | 🔒 LOCKED |
| DB-T-6 | 5.4.1 | `pod_status` off the default column set | 🔒 LOCKED |
| DB-K-1 | 5.4.2 | Column set = actual 9-status state machine; no invented "Exception" column | 🔒 LOCKED |
| DB-K-2 | 5.4.2 | Direct / assisted / blocked drag rules per transition | 🔒 LOCKED |
| DB-K-3 | 5.4.2 | No financial figures on Kanban cards, any role | 🔒 LOCKED |
| DB-K-4 | 5.4.2 | Default card sort: soonest operational date ascending | 🔒 LOCKED |
| DB-C-1 | 5.4.3 | Stop-level calendar events; icon (not color) for Pickup/Delivery type | 🔒 LOCKED |
| DB-C-2 | 5.4.3 | Event color = `Stop.status`, with overdue/pending danger override | 🔒 LOCKED |
| DB-C-3 | 5.4.3 | Unscheduled Stops panel | 🔒 LOCKED |
| DB-C-4 | 5.4.3 | Interactive drag-to-reschedule (`appointment_datetime` only, audited) | 🔒 LOCKED |
| DB-C-5 | 5.4.3 | Default view: Week, manual toggle only, no viewport auto-switch | 🔒 LOCKED |
| LD-1 | 5.4.4 | Six-tab structure + lifecycle stepper | 🔒 LOCKED |
| LD-2 | 5.4.4 | Context-sensitive header primary action per `Load.status` | 🔒 LOCKED |
| LD-3 | 5.4.4 | Primary action at `DELIVERED` = Create/View Customer Invoice | 🔒 LOCKED |
| LD-4 | 5.4.4 | Financials tab fully hidden for Dispatcher | 🔒 LOCKED |
| LD-5 | 5.4.4 | D9 "Add Charge" UI (Admin/Ops Mgr/Dispatcher/Accounting, no approval) | 🔒 LOCKED |
| LD-6 | 5.4.4 | Activity History audit entries apply the same financial redaction rules | 🔒 LOCKED |
| CD-1 | 5.4.5 | Six-tab structure per the §5.1.4 sitemap | 🔒 LOCKED |
| CD-2 | 5.4.5 | Accounting excluded from "+ New Quote" (not a Workflow 4 creator role) | 🔒 LOCKED |
| CD-3 | 5.4.5 | Customer status badge mapping (mirrors Carrier's Pending/Active/Inactive/Blocked treatment) | 🔒 LOCKED |
| CD-4 | 5.4.5 | Expired Rate Agreement badge is display-only | 🔒 LOCKED |
| CD-5 | 5.4.5 | Contact/Location removal: standard confirmation only, fully audited | 🔒 LOCKED |
| CR-1 | 5.4.6 | Carrier Status and Assignment Eligibility as two separate, equally prominent badges | 🔒 LOCKED |
| CR-2 | 5.4.6 | Eligibility Checklist card is a direct rendering of Workflow 3 §3.8 | 🔒 LOCKED |
| CR-3 | 5.4.6 | Self-review prevention reflected in Approve/Reject UI | 🔒 LOCKED |
| CR-4 | 5.4.6 | COI upload/review lives on the Insurance tab, not Compliance | 🔒 LOCKED |
| CR-5 | 5.4.6 | Lane/Region Preferences — new `CarrierServiceArea` schema (DATABASE_DESIGN.md D16) | 🔒 LOCKED |
| CR-6 | 5.4.6 | FMCSA Verification placed on the Compliance tab (placement only) | 🔒 LOCKED |
| INV-1 | 5.4.7 | Invoice Builder: customer-first selection, Individual vs. Consolidated paths | 🔒 LOCKED |
| INV-2 | 5.4.7 | POD-incomplete warning modal reused verbatim from Workflow 8 §8.2 | 🔒 LOCKED |
| INV-3 | 5.4.7 | Send / Record Payment / Add Adjustment / Void action set | 🔒 LOCKED |
| INV-4 | 5.4.7 | Operations Manager: full view, zero invoice actions (not a Workflow 8 actor) | 🔒 LOCKED |
| LC-1 | 5.4.8 | Checklist rendering; `Close Load` always enabled, never hard-blocked | 🔒 LOCKED |
| LC-2 | 5.4.8 | No secondary confirmation modal (Workflow 10's own acknowledgment mechanism governs) | 🔒 LOCKED |
| LC-3 | 5.4.8 | No `DELIVERED` precondition added — Workflow 10 preserved exactly | 🔒 LOCKED |
| INT-1–12 | 5.5.1–5.5.12 | Loading/empty/error/validation/permission/feedback/modal/form/transition/destructive/table/responsive patterns, consolidated | 🔒 LOCKED |
| INT-13 | 5.5.13 | Keyboard-accessible alternative to drag-and-drop: `Move to…` (Kanban) / `Reschedule` (Calendar), additive to drag-and-drop, same permissions/validation/workflow rules | 🔒 LOCKED |

**58 decisions total: 58 locked, 0 open.** 🔒 **Stage 5 UI/UX Design is fully locked.**

### 5.6.2 Final Resolutions (formerly open)

- **SH-9:** Minimal self-service profile editing added — name and password only, in the User menu (§5.3.4). No broader account settings. Organization membership, roles, permissions, and other administrative identity controls remain outside self-service reach (Admin/Workflow-1-governed only).
- **SH-10:** "Mark all as read" added to the Notifications panel (§5.3.7) — UI convenience only, no new notification types or business rules.
- **SH-11:** Dashboard gets a "Getting Started" guide for a brand-new organization (Invite your team / Add a Customer / Add a Carrier). Every other screen uses its standard empty state (§5.5.2) — no bespoke onboarding content elsewhere, no new onboarding workflow.
- **INT-13:** `Move to…` (Kanban card kebab menu) and `Reschedule` (Calendar event action) added as keyboard-reachable equivalents — both route through the exact same assisted-transition modals/flows and permission/validation/workflow checks as their drag-and-drop counterparts. Drag-and-drop remains available; these are additive, not replacements.

---

**Stage 5 UI/UX Design (5.1–5.6) is complete and fully locked.** Proceeding to 5.7 Prototype.
