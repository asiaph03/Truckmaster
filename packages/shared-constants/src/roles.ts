/**
 * Mirrors `MembershipRoleName` in backend/prisma/schema.prisma verbatim.
 * This is a re-declaration, not an import — Prisma-generated types can't
 * cross into a browser bundle — so this file is the single place both
 * frontend and backend intend to read the same 6 role names from.
 */
export const MEMBERSHIP_ROLES = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
  'ACCOUNTING',
  'COMPLIANCE_REVIEWER',
] as const;

export type MembershipRoleName = (typeof MEMBERSHIP_ROLES)[number];

/**
 * TECHNICAL_ARCHITECTURE.md §7 / quote-load/services/financial-field-shaping.ts
 * `FULL_VISIBILITY_ROLES` — the three roles with unredacted access to
 * customerRate/carrierRate/margin/invoice totals everywhere those fields
 * appear.
 */
export const FULL_FINANCIAL_VISIBILITY_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'ACCOUNTING',
];

/**
 * COMPLIANCE_REVIEWER is additive/layered (UI_UX_DESIGN.md §5.1.6,
 * Workflow 3) — a membership can hold it alongside one of the 5 base
 * operational roles above, not instead of one.
 */
export const ADDITIVE_ROLES: MembershipRoleName[] = ['COMPLIANCE_REVIEWER'];
