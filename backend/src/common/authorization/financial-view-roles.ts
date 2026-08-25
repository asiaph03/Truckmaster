import { MembershipRoleName } from '@prisma/client';

/**
 * Admin / Accounting / Operations Manager — the financial "full view" role
 * set shared by Invoice, Carrier Payment, and Reporting (AR/AP Aging,
 * dashboard financial block) view/read authorization. Previously
 * redefined independently as an identical literal in five places
 * (InvoiceService.FULL_VIEW_ROLES, CarrierPaymentController.VIEW_ROLES,
 * CarrierPaymentService.VIEW_ROLES, ReportingController.FINANCIAL_REPORT_ROLES,
 * ReportingService.INVOICE_FULL_VIEW_ROLES) — centralized here (Frontend
 * Phase 9 maintenance pass) so the five copies can't silently drift out of
 * sync. Pure refactor: the role set itself is unchanged.
 *
 * Distinct from quote-load/services/financial-field-shaping.ts's
 * FULL_VISIBILITY_ROLES — same three roles and the same underlying
 * concept, but that constant is scoped to Load/Quote/Activity-History
 * financial-field redaction. Not merged with it here; this pass was
 * scoped to exactly the five call sites named above.
 */
export const FINANCIAL_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'ACCOUNTING',
  'OPERATIONS_MANAGER',
];
