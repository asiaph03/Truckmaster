import type { MembershipRoleName } from './roles';

/**
 * Named after the rows of TECHNICAL_ARCHITECTURE.md §7's permission
 * matrix / UI_UX_DESIGN.md §5.1.6's nav-visibility table, so any call
 * site tracing a permission key back to its source-of-truth row finds
 * it directly. This is a UX-hiding aid only — the backend Guards and
 * `shapeFinancialFields` (quote-load/services/financial-field-shaping.ts)
 * remain the sole enforcement point; a wrong or missing check here fails
 * safe as a server-side 403/redaction, never as a data leak.
 */
export type PermissionKey =
  | 'viewLoadFinancials'
  | 'manageMemberships'
  | 'reviewComplianceDocuments'
  | 'approveOrRejectCarrierPayment'
  | 'createOrSubmitCarrierPayment'
  | 'sendOrVoidInvoice'
  | 'recordPaymentOrAdjustment'
  | 'manageCustomers'
  | 'manageCarriers'
  | 'sourceAndDispatchLoads'
  | 'createQuoteOrLoad'
  | 'viewArApAging'
  // Frontend Phase 2 additions — `manageCarriers`'s role set (Admin/Ops
  // Manager/Dispatcher) does NOT cover carrier insurance, FMCSA
  // verification, or activation; those three are their own distinct
  // @Roles() gates on the backend (carrier.controller.ts), so they need
  // their own keys rather than being folded into manageCarriers.
  | 'addCarrierInsurance'
  | 'recordFmcsaVerification'
  | 'activateCarrier'
  // Customer Detail's Rate Agreements/Invoices tabs are hidden entirely
  // for Dispatcher (UI_UX_DESIGN.md §5.4.5) — a viewing distinction
  // independent of `manageCustomers` (create/edit), since even a
  // Dispatcher-only membership can view the other 4 tabs.
  | 'viewCustomerFinancialTabs';

export const ROLE_PERMISSIONS: Record<MembershipRoleName, PermissionKey[]> = {
  ADMIN: [
    'viewLoadFinancials',
    'manageMemberships',
    // Deliberately NOT 'reviewComplianceDocuments' — the backend gates
    // POST /documents/:id/review to @Roles('COMPLIANCE_REVIEWER')
    // exclusively (a segregation-of-duties control, Workflow 3 §3.4),
    // with no Admin override. Same reasoning for 'activateCarrier' and
    // 'recordFmcsaVerification' below, neither of which Admin has
    // either. This was a pre-existing gap in the matrix (present since
    // Phase 1, when nothing yet exercised these 3 keys) — caught during
    // Phase 2 manual verification against the real backend, not
    // something newly introduced.
    'approveOrRejectCarrierPayment',
    'createOrSubmitCarrierPayment',
    'sendOrVoidInvoice',
    'recordPaymentOrAdjustment',
    'manageCustomers',
    'manageCarriers',
    'sourceAndDispatchLoads',
    'createQuoteOrLoad',
    'viewArApAging',
    'addCarrierInsurance',
    'viewCustomerFinancialTabs',
  ],
  OPERATIONS_MANAGER: [
    'viewLoadFinancials',
    'createOrSubmitCarrierPayment',
    'manageCustomers',
    'manageCarriers',
    'sourceAndDispatchLoads',
    'createQuoteOrLoad',
    'viewArApAging',
    'addCarrierInsurance',
    'viewCustomerFinancialTabs',
    // No manageMemberships, approveOrRejectCarrierPayment, or
    // sendOrVoidInvoice/recordPaymentOrAdjustment — Ops Manager has full
    // *view* parity with Admin (UI_UX_DESIGN.md §5.1.7 item 1) but not
    // these Admin/Accounting-only actions.
  ],
  DISPATCHER: [
    'manageCarriers',
    'sourceAndDispatchLoads',
    'createQuoteOrLoad',
    'addCarrierInsurance',
    // No viewLoadFinancials, no billing actions, no viewArApAging —
    // financials/Billing nav are hidden entirely for Dispatcher.
  ],
  SALES_BOOKING: [
    'manageCustomers',
    'createQuoteOrLoad',
    'viewCustomerFinancialTabs',
    // viewLoadFinancials deliberately absent as a blanket grant — Sales
    // sees revenue only on "own deal" records (Account Owner, falling
    // back to creator), never margin/carrier cost regardless of
    // ownership (UI_UX_DESIGN.md §5.4.1 Resolution 1). That row-level
    // exception is applied at the data layer (matches what the backend
    // already returns), not as a blanket permission here.
  ],
  ACCOUNTING: [
    'viewLoadFinancials',
    'createOrSubmitCarrierPayment',
    'sendOrVoidInvoice',
    'recordPaymentOrAdjustment',
    'manageCustomers',
    'viewArApAging',
    'viewCustomerFinancialTabs',
    // No manageMemberships, no approveOrRejectCarrierPayment (Admin-only,
    // self-review-forbidden also applies), no sourceAndDispatchLoads
    // (view-only on Loads ops actions), no manageCarriers/
    // addCarrierInsurance (view-only on Carriers entirely).
  ],
  COMPLIANCE_REVIEWER: [
    'reviewComplianceDocuments',
    'addCarrierInsurance',
    'recordFmcsaVerification',
    'activateCarrier',
    // Additive role — layered on top of one of the 5 base roles above,
    // never granted alone.
  ],
};

export function roleHasPermission(roles: MembershipRoleName[], permission: PermissionKey): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission));
}

/**
 * UI_UX_DESIGN.md §5.1.3 sidebar items. `loadsFinancial` is not a nav
 * item itself — it gates the financial columns/tab *within* Loads, kept
 * separate from `loads` (which everyone with any Loads access sees).
 */
export const NAV_ITEMS = [
  'dashboard',
  'loads',
  'customers',
  'carriers',
  'billing',
  'documents',
  'reports',
  'settings',
] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

/**
 * UI_UX_DESIGN.md §5.1.6 role-based navigation visibility table,
 * ported verbatim. `true` = nav item shown (content may still be
 * scoped/redacted within the screen — e.g. Sales sees Customers full,
 * but Billing only for their own deals).
 */
export const NAV_VISIBILITY: Record<MembershipRoleName, Record<NavItem, boolean>> = {
  ADMIN: {
    dashboard: true,
    loads: true,
    customers: true,
    carriers: true,
    billing: true,
    documents: true,
    reports: true,
    settings: true,
  },
  OPERATIONS_MANAGER: {
    dashboard: true,
    loads: true,
    customers: true,
    carriers: true,
    billing: true,
    documents: true,
    reports: true,
    settings: false,
  },
  DISPATCHER: {
    dashboard: true,
    loads: true,
    customers: true,
    carriers: true,
    billing: false,
    documents: true,
    reports: true,
    settings: false,
  },
  SALES_BOOKING: {
    dashboard: true,
    loads: true,
    customers: true,
    carriers: true,
    billing: true,
    documents: true,
    reports: true,
    settings: false,
  },
  ACCOUNTING: {
    dashboard: true,
    loads: true,
    customers: true,
    carriers: true,
    billing: true,
    documents: true,
    reports: true,
    settings: false,
  },
  COMPLIANCE_REVIEWER: {
    // Additive — never the sole role, so this row is never consulted on
    // its own; NAV_VISIBILITY lookups always union across a membership's
    // full role list (see canSeeNav in frontend's usePermissions()).
    dashboard: false,
    loads: false,
    customers: false,
    carriers: true,
    billing: false,
    documents: true,
    reports: false,
    settings: false,
  },
};
