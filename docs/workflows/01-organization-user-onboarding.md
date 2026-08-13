# Workflow 1: Organization & User Onboarding
**Status:** 🔒 LOCKED
**Stage:** 2 — Business Workflows
**Source of truth:** [docs/PRD.md](../PRD.md)

## Actors
| Actor | Description |
|---|---|
| **Platform Super Admin** | Your platform's own operator — provisions organizations, has no automatic access to org operational/financial data |
| **Organization Admin** | First user of a new org; manages users, roles, invitations within their org |
| **Invited User** | Any internal role (Operations Manager, Dispatcher, Sales/Booking, Accounting) invited by an Org Admin |
| **System** | The TMS application (email delivery, validation, token generation, audit logging) |

## Overall Trigger
A business relationship is established outside the system (sales/onboarding conversation), and the Platform Super Admin provisions a new Organization.

## Overall Preconditions
- Platform Super Admin has an active platform-level account.
- Basic company information for the new org has been collected (outside the system, e.g., via a sales process).

---

## 1.1 Organization Creation

**Actors:** Platform Super Admin, System
**Trigger:** Platform Super Admin initiates "Create Organization"
**Preconditions:** None (root-level action)

| Step | User (Platform Super Admin) | System |
|---|---|---|
| 1 | Enters company/legal name, address, primary contact name, email, phone | — |
| 2 | Submits form | Validates required fields present; validates email format; checks org name/primary contact email not already in use |
| 3 | — | Creates `Organization` record with status `Active` and `default_payment_terms` = **Net 30** |
| 4 | — | Creates initial `Organization Admin` user record (see 1.2) |
| 5 | — | Writes audit event: `Organization Created` |

**System Validations**
- Legal name, address, primary contact name/email/phone all required.
- Primary contact email must be a valid, uniquely-usable email (a user's login identity is global even though data is org-scoped).

**Status Transitions:** Organization: `(none)` → `Active`
**Data Created:** `Organization` record (name, address, contact info, `default_payment_terms` = Net 30, created_by = Super Admin, created_at)

**Note:** `default_payment_terms` is set to Net 30 automatically at provisioning and is the value Customer Creation (Workflow 2) reads at the moment a new Customer is created. Changing the organization's default later (e.g., via a future Organization Settings workflow) does not retroactively change any customer's already-set terms. Other organization-level settings (numbering formats, etc.) are out of scope for this workflow and belong to that future Organization Settings workflow.
**Documents Generated:** None
**Notifications:** None yet (triggered in 1.2)
**Audit Events:** `Organization Created` (actor: Super Admin, entity: Organization)
**Handoff:** → 1.2 Initial Admin Creation (system-triggered immediately, same transaction)

**Exceptions**
- Duplicate primary contact email → System blocks creation, shows error, Super Admin corrects and resubmits.
- Incomplete required fields → System blocks submission with field-level errors.

**Completion Criteria:** Organization record exists with status `Active`, ready to receive its initial Admin user.

---

## 1.2 Initial Admin Account Creation

**Actors:** System, Initial Admin (passive recipient)
**Trigger:** Organization successfully created (system-triggered, immediately follows 1.1)
**Preconditions:** Organization record exists

| Step | User | System |
|---|---|---|
| 1 | — | Creates `User` record using Organization's primary contact info (name, email) |
| 2 | — | Assigns role: `Admin` |
| 3 | — | Sets user status: `Pending Verification` |
| 4 | — | Generates email verification token (time-limited) |
| 5 | — | Sends verification email to primary contact |
| 6 | — | Writes audit event: `Initial Admin Account Created` |

**System Validations:** One and only one initial Admin is created per new Organization.
**Status Transitions:** User: `(none)` → `Pending Verification`
**Data Created:** `User` record: organization_id, name, email, role = [Admin], status = Pending Verification, invited_by = System, created_at
**Documents Generated:** None
**Notifications:** Email — "Verify your account" sent to primary contact
**Audit Events:** `Initial Admin Account Created` (actor: System, on behalf of Super Admin's org-creation action)
**Handoff:** → 1.3 Email Verification

**Completion Criteria:** Admin user record exists in `Pending Verification` status with a valid verification token sent.

---

## 1.3 Email Verification (Initial Admin)

**Actors:** Initial Admin, System
**Trigger:** Initial Admin opens the verification email and clicks the link
**Preconditions:** User status = `Pending Verification`; token not expired

| Step | User (Initial Admin) | System |
|---|---|---|
| 1 | Clicks verification link | Validates token: exists, unexpired, unused |
| 2 | — | Prompts user to set a password |
| 3 | Enters and confirms password | Validates password meets policy |
| 4 | Submits | Sets user status: `Active`; marks token used; writes audit event `Admin Account Verified` |
| 5 | — | Logs Admin into the application |

**System Validations:** Token must be unexpired and unused. Password must meet minimum complexity policy (exact policy is a technical-architecture detail).
**Status Transitions:** User: `Pending Verification` → `Active`
**Data Updated:** `User.status` = Active, `User.password_hash` set, `User.verified_at` set
**Documents Generated:** None
**Notifications:** None (confirmation shown in-app)
**Audit Events:** `Admin Account Verified` (actor: Initial Admin)
**Handoff:** → Admin is now fully active and may begin inviting additional users (1.4)

**Exceptions**
- **Expired token:** System shows "link expired," offers "Resend Verification Email" (regenerates token, resends).
- **Token already used:** System shows "already verified," directs to login.

**Completion Criteria:** Admin user status = `Active`; Admin can log in and access the organization.

---

## 1.4 User Invitation (Org Admin invites additional users)

**Actors:** Organization Admin, System, Invited User (passive recipient)
**Trigger:** Org Admin initiates "Invite User"
**Preconditions:** Org Admin is `Active`; Organization exists

| Step | User (Org Admin) | System |
|---|---|---|
| 1 | Enters invitee's email address | — |
| 2 | Selects one or more roles (Operations Manager, Dispatcher, Sales/Booking, Accounting, Admin) | — |
| 3 | Submits invitation | Validates email format; checks whether email already belongs to a user in this org |
| 4 | — | Creates `User` record: status = `Invited`, roles = selected roles |
| 5 | — | Generates invitation token, expiring in **7 days** |
| 6 | — | Sends invitation email to invitee |
| 7 | — | Writes audit event: `User Invited` (records roles assigned) |

**System Validations**
- Email required and valid format.
- Cannot invite an email already active in this organization.
- Re-inviting an email with a prior expired/cancelled invitation is allowed (fresh token).
- At least one role must be selected.

**Status Transitions:** User: `(none)` → `Invited`
**Data Created:** `User` record: organization_id, email, roles[], status = Invited, invited_by = Org Admin, invited_at, invitation_expires_at (+7 days)
**Documents Generated:** None
**Notifications:** Email — "You've been invited to join [Organization] on [TMS]" with acceptance link
**Audit Events:** `User Invited` (actor: Org Admin, target: invited email, roles assigned)
**Handoff:** → 1.5 Invitation Acceptance

**Exceptions**
- Email already belongs to an active user in the org → System blocks with error.
- Email already has a pending (unexpired) invitation → System offers "Resend" instead of duplicating.

**Completion Criteria:** `User` record exists in `Invited` status with an active, unexpired invitation token and roles pre-assigned.

---

## 1.5 Invitation Acceptance & User Activation

**Actors:** Invited User, System
**Trigger:** Invited User clicks the invitation link
**Preconditions:** User status = `Invited`; invitation token unexpired and uncancelled

| Step | User (Invited User) | System |
|---|---|---|
| 1 | Clicks invitation link | Validates token: exists, unexpired, not cancelled, not already used |
| 2 | — | Displays invitation details (organization name, assigned role(s)) and password-setup form |
| 3 | Enters name confirmation (if needed) and sets password | Validates password policy |
| 4 | Submits | Sets user status: `Active`; marks invitation token used; writes audit event `User Activated` |
| 5 | — | Logs new user into the application |

**System Validations:** Token unexpired, uncancelled, unused. Password meets policy.
**Status Transitions:** User: `Invited` → `Active`
**Data Updated:** `User.status` = Active, `User.password_hash` set, `User.activated_at` set
**Documents Generated:** None
**Notifications:** None further (in-app confirmation)
**Audit Events:** `User Activated` (actor: Invited User)
**Handoff:** User now has standing access per assigned role(s)

**Exceptions**
- **Expired invitation (>7 days):** "This invitation has expired." User cannot activate; Org Admin must resend (1.6).
- **Cancelled invitation:** "This invitation is no longer valid."
- **Already accepted:** "This invitation has already been used," directs to login.

**Completion Criteria:** User status = `Active`, roles in effect, user can log in.

---

## 1.6 Invitation Lifecycle Management (Expire / Resend / Cancel)

**Actors:** Organization Admin, System
**Trigger:** (a) 7 days elapse with no acceptance, or (b) Org Admin manually resends/cancels

| Step | User (Org Admin) | System |
|---|---|---|
| 1a | — | (Automatic) When current date > invitation_expires_at and status still `Invited`, System marks invitation `Expired` |
| 1b | Views pending invitations, selects "Resend" | Generates new token, resets expiration to +7 days, resends email; writes audit event `Invitation Resent` |
| 1c | Selects "Cancel" on a pending/expired invitation | Sets user status `Cancelled`; invalidates outstanding token; writes audit event `Invitation Cancelled` |

**Status Transitions**
- User: `Invited` → `Expired` (automatic, time-based)
- User: `Invited`/`Expired` → `Invited` (on Resend — new token, same record)
- User: `Invited`/`Expired` → `Cancelled` (on Cancel)

**Data Updated:** `User.status`, `User.invitation_expires_at`, invitation token fields
**Notifications:** New invitation email sent on Resend
**Audit Events:** `Invitation Resent`, `Invitation Cancelled`, `Invitation Expired` (system-generated)
**Completion Criteria:** Invitation is in a definitive terminal or renewed state; expired/cancelled invitations cannot be used to activate an account.

---

## 1.7 User Deactivation

**Actors:** Organization Admin, System
**Trigger:** Org Admin initiates "Deactivate User" on an Active user
**Preconditions:** Target user status = `Active`; acting user has Admin role

| Step | User (Org Admin) | System |
|---|---|---|
| 1 | Selects user, chooses "Deactivate" | System checks whether target is an Admin and, if so, counts other currently-Active Admins in the org |
| 2 | Confirms action (with warning that assignments are not auto-reassigned) | If this would leave zero Active Admins, System **blocks the action** and displays a clear explanation (see Validations) |
| 3 | — | If validation passes: sets user status `Inactive`; revokes login/session access immediately |
| 4 | — | Retains all existing assignments (loads, customers, carriers) as-is, associated with the now-inactive user |
| 5 | — | Writes audit event: `User Deactivated` |
| 6 | — | Flags user as `Inactive` everywhere they appear in the UI (e.g., assignment pickers) — excluded from new-assignment selection, but existing history/labels remain intact |

**System Validations**
- Only Admin role may deactivate a user.
- **Zero-Admin protection:**
  - An Admin **cannot deactivate their own account** if they are the only active Admin in the organization.
  - An Admin **cannot deactivate another user** if doing so would leave the organization with zero active Admins.
  - A **second active Admin must exist** before the current last Admin can be deactivated.
  - When blocked, the system displays a clear message (e.g., *"You cannot deactivate this user because they are the only active Admin in your organization. Assign Admin to another user first."*).

**Status Transitions:** User: `Active` → `Inactive`
**Data Updated:** `User.status` = Inactive, `User.deactivated_at`, `User.deactivated_by`
**Data NOT Changed:** `assigned_dispatcher`, `account_owner`, `created_by`, historical audit entries — all continue to reference the original user by identity.
**Documents Generated:** None
**Notifications:** None specified
**Audit Events:** `User Deactivated` (actor: Org Admin, target: deactivated user); `User Deactivation Blocked — Last Active Admin` (system-generated, when blocked, for traceability)
**Handoff:** Existing assignments remain until another authorized user manually reassigns them via normal operational workflows (outside this workflow)

**Exceptions**
- Attempt to deactivate the last remaining active Admin (self or other) → System blocks with explanatory error.
- Deactivated user's active sessions are terminated immediately.

**Completion Criteria:** User status = `Inactive`; user cannot log in; all historical and current associations remain visibly attributed to them; user excluded from future-assignment pickers; organization retains at least one active Admin at all times.

---

## 1.8 No Deletion Principle
There is no "delete user" action anywhere in V1. Deactivation is the only offboarding mechanism. All historical records — audit events, load/customer/carrier assignments, notes, financial actions, status changes — permanently retain the original user's identity, whether that user is Active or Inactive.

---

## Cross-Cutting: Audit Logging Summary

| Event | Actor |
|---|---|
| `Organization Created` | Platform Super Admin |
| `Initial Admin Account Created` | System |
| `Admin Account Verified` | Initial Admin |
| `User Invited` | Organization Admin |
| `Invitation Resent` | Organization Admin |
| `Invitation Cancelled` | Organization Admin |
| `Invitation Expired` | System (automatic) |
| `User Activated` | Invited User |
| `User Deactivated` | Organization Admin |
| `User Deactivation Blocked — Last Active Admin` | System (automatic, on blocked attempt) |

---

*Locked as part of Stage 2 — Business Workflows. Defines organization provisioning, initial admin setup, user invitation/activation, invitation lifecycle, and deactivation (including the zero-Admin protection rule). Does not cover role/permission definitions in detail (see PRD Section 3 and 7) or SaaS billing/subscription mechanics (explicitly out of scope for V1).*
