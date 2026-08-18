import { MembershipRoleName } from '@prisma/client';

interface FinancialShapeable {
  createdByUserId: string;
  customerRate: unknown;
  rateSource: unknown;
  rateAgreementId: unknown;
}

const FULL_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN', 'OPERATIONS_MANAGER', 'ACCOUNTING'];

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

  return { ...record, customerRate: null, rateSource: null, rateAgreementId: null };
}

export function shapeFinancialFieldsList<T extends FinancialShapeable>(
  records: T[],
  actingRoles: MembershipRoleName[],
  actingUserId: string,
): T[] {
  return records.map((record) => shapeFinancialFields(record, actingRoles, actingUserId));
}
