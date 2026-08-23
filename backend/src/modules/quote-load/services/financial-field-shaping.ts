import { MembershipRoleName } from '@prisma/client';

interface FinancialShapeable {
  createdByUserId: string;
  customerRate: unknown;
  rateSource: unknown;
  rateAgreementId: unknown;
  /**
   * Post-Phase-8 remediation (Priority 1) — optional because not every
   * shaped record carries them (e.g. a bare Quote has neither). Present on
   * `Load` (carrierRate, a raw scalar Prisma always returns) and on
   * `LoadService.getReadyToInvoice`'s computed `customerChargesTotal`
   * field — both were leaking to Dispatcher because this helper never
   * knew about them.
   */
  carrierRate?: unknown;
  customerChargesTotal?: unknown;
  /**
   * Frontend Phase 3 remediation — `LoadService.findById` includes the
   * full `sourcingAttempts` history (Carrier & Dispatch tab, §5.4.4), and
   * each attempt carries its own `carrierRate`. This helper redacted only
   * the top-level `Load.carrierRate`; the nested per-attempt rate was
   * never touched, so Dispatcher/non-owning Sales-Booking could still read
   * carrier cost off the Sourcing Attempts table even though the Current
   * Assignment card correctly showed it redacted. Optional for the same
   * reason as the fields above — a bare Quote/Load-list row has none.
   */
  sourcingAttempts?: { carrierRate: unknown }[];
}

/**
 * Exported (was module-private) so callers needing a guard-level check —
 * e.g. `LoadController`'s `ready-to-invoice` route — can reuse the exact
 * same role list this helper redacts against, rather than duplicating it.
 */
export const FULL_VISIBILITY_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'ACCOUNTING',
];

/**
 * TECHNICAL_ARCHITECTURE.md §7 — "View (financial fields per
 * ownership/role)": Dispatcher never sees $ fields on a Quote/Load;
 * Sales/Booking sees them only on records they created themselves ("own
 * deals $"). Admin/Ops Manager/Accounting see financial fields
 * unrestricted. A user can hold multiple roles at once (§7 cross-cutting
 * note), so this grants full visibility if ANY held role qualifies —
 * role restrictions are a floor, not mutually exclusive.
 */
export function shapeFinancialFields<T extends FinancialShapeable>(
  record: T,
  actingRoles: MembershipRoleName[],
  actingUserId: string,
): T {
  if (actingRoles.some((role) => FULL_VISIBILITY_ROLES.includes(role))) return record;
  if (actingRoles.includes('SALES_BOOKING') && record.createdByUserId === actingUserId)
    return record;

  return {
    ...record,
    customerRate: null,
    rateSource: null,
    rateAgreementId: null,
    ...('carrierRate' in record ? { carrierRate: null } : {}),
    ...('customerChargesTotal' in record ? { customerChargesTotal: null } : {}),
    ...('sourcingAttempts' in record && record.sourcingAttempts
      ? { sourcingAttempts: record.sourcingAttempts.map((a) => ({ ...a, carrierRate: null })) }
      : {}),
  };
}

export function shapeFinancialFieldsList<T extends FinancialShapeable>(
  records: T[],
  actingRoles: MembershipRoleName[],
  actingUserId: string,
): T[] {
  return records.map((record) => shapeFinancialFields(record, actingRoles, actingUserId));
}
