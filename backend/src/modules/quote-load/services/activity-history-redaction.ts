import { MembershipRoleName } from '@prisma/client';
import { FULL_VISIBILITY_ROLES } from './financial-field-shaping';

/**
 * Frontend Phase 7 (Activity History, UI_UX_DESIGN.md §5.4.4, Decision
 * LD-6) — "Dispatcher never sees restricted rate/cost/margin amounts
 * anywhere, including inside Activity History entries... Redaction happens
 * at the presentation/API authorization layer only — the underlying
 * AuditLog record is never altered or deleted."
 *
 * Deliberately a structured recursive key-name redactor over the parsed
 * previousValue/newValue JSON, not a regex over serialized text — a
 * free-text field (e.g. a future `reason`) containing a financial key's
 * name as a substring would false-positive under a naive string-regex
 * approach. This reuses the exact same role/ownership gates as
 * `shapeFinancialFields` (imported, not duplicated) rather than
 * introducing a separate permission model.
 */
const CUSTOMER_SIDE_KEYS = new Set([
  'customerRate',
  'rateSource',
  'rateAgreementId',
  'customerChargesTotal',
]);
const CARRIER_SIDE_KEYS = new Set(['carrierRate', 'remainingCarrierBalance']);

function redactValue(value: unknown, showCustomerSide: boolean, showCarrierSide: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, showCustomerSide, showCarrierSide));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Charge Line Item payload shape: { side: 'CUSTOMER' | 'CARRIER', amount }.
    // `amount`'s visibility follows its own sibling `side`, not a fixed key list.
    const sideHint = obj.side === 'CUSTOMER' || obj.side === 'CARRIER' ? obj.side : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (sideHint && key === 'amount') {
        out[key] = (sideHint === 'CUSTOMER' ? showCustomerSide : showCarrierSide) ? val : null;
      } else if (CUSTOMER_SIDE_KEYS.has(key)) {
        out[key] = showCustomerSide ? redactValue(val, showCustomerSide, showCarrierSide) : null;
      } else if (CARRIER_SIDE_KEYS.has(key)) {
        out[key] = showCarrierSide ? redactValue(val, showCustomerSide, showCarrierSide) : null;
      } else {
        out[key] = redactValue(val, showCustomerSide, showCarrierSide);
      }
    }
    return out;
  }
  return value;
}

export interface RedactableAuditEntry {
  previousValue: unknown;
  newValue: unknown;
}

export function redactAuditFinancialFields<T extends RedactableAuditEntry>(
  entry: T,
  actingRoles: MembershipRoleName[],
  actingUserId: string,
  loadCreatedByUserId: string,
): T {
  const fullVisibility = actingRoles.some((role) => FULL_VISIBILITY_ROLES.includes(role));
  const ownDeal = actingRoles.includes('SALES_BOOKING') && loadCreatedByUserId === actingUserId;

  const showCustomerSide = fullVisibility || ownDeal;
  const showCarrierSide = fullVisibility;

  if (showCustomerSide && showCarrierSide) return entry;

  return {
    ...entry,
    previousValue: redactValue(entry.previousValue, showCustomerSide, showCarrierSide),
    newValue: redactValue(entry.newValue, showCustomerSide, showCarrierSide),
  };
}
