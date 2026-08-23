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
  /**
   * Frontend Phase 4 gap-fix — `LoadService.findById` now includes
   * `chargeLineItems` (Financials tab's Customer/Carrier-side table,
   * §5.4.4). Each item's `amount` is redacted per its own `side`, not as
   * a block — a CUSTOMER-side charge follows the same visibility as
   * `customerRate`, a CARRIER-side charge follows `carrierRate`.
   */
  chargeLineItems?: { side: 'CUSTOMER' | 'CARRIER'; amount: unknown }[];
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
 * Sales/Booking sees customer-side fields only on records they created
 * themselves ("own deals $"). Admin/Ops Manager/Accounting see every
 * financial field unrestricted. A user can hold multiple roles at once
 * (§7 cross-cutting note), so this grants full visibility if ANY held
 * role qualifies — role restrictions are a floor, not mutually exclusive.
 *
 * Frontend Phase 4 correction — customer-side and carrier-side visibility
 * are two independent gates, not one combined on/off switch. The
 * previous version returned the entire record unredacted (including
 * `carrierRate`/carrier-side `sourcingAttempts`) for Sales/Booking on
 * their own deal, which contradicts the locked rule that Margin is never
 * shown to Sales/Booking, ownership notwithstanding (§5.4.1 Resolution
 * 1) — an unredacted `carrierRate` lets the exact same margin be derived
 * client-side from `customerRate - carrierRate`. Sales/Booking now sees
 * customer-side amounts on their own deals (as before) but never
 * carrier-side amounts, regardless of ownership.
 */
export function shapeFinancialFields<T extends FinancialShapeable>(
  record: T,
  actingRoles: MembershipRoleName[],
  actingUserId: string,
): T {
  const fullVisibility = actingRoles.some((role) => FULL_VISIBILITY_ROLES.includes(role));
  const ownDeal = actingRoles.includes('SALES_BOOKING') && record.createdByUserId === actingUserId;

  const showCustomerSide = fullVisibility || ownDeal;
  const showCarrierSide = fullVisibility;

  if (showCustomerSide && showCarrierSide) return record;

  return {
    ...record,
    ...(showCustomerSide ? {} : { customerRate: null, rateSource: null, rateAgreementId: null }),
    ...('carrierRate' in record && !showCarrierSide ? { carrierRate: null } : {}),
    ...('customerChargesTotal' in record && !showCustomerSide
      ? { customerChargesTotal: null }
      : {}),
    ...('sourcingAttempts' in record && record.sourcingAttempts && !showCarrierSide
      ? { sourcingAttempts: record.sourcingAttempts.map((a) => ({ ...a, carrierRate: null })) }
      : {}),
    ...('chargeLineItems' in record && record.chargeLineItems
      ? {
          chargeLineItems: record.chargeLineItems.map((c) => {
            const visible = c.side === 'CUSTOMER' ? showCustomerSide : showCarrierSide;
            return visible ? c : { ...c, amount: null };
          }),
        }
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
