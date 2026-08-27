/**
 * UI_UX_DESIGN.md §5.2.1 status badge mapping table, ported verbatim.
 * Keys are `Entity.field:VALUE` so the same string value on different
 * entities (e.g. `Carrier.status` PENDING vs `CarrierPayment.status`
 * DRAFT) never collides. Colors reference the CSS custom properties in
 * src/styles/tokens.css — no hex codes duplicated here.
 */

export type BadgeColor = 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export const STATUS_BADGE_MAP: Record<string, BadgeColor> = {
  // Load.status
  'Load.status:BOOKED': 'brand',
  'Load.status:CARRIER_SOURCING': 'brand',
  'Load.status:CARRIER_ASSIGNED': 'brand',
  'Load.status:RATE_CONFIRMATION': 'brand',
  'Load.status:DISPATCHED': 'brand',
  'Load.status:PICKUP': 'brand',
  'Load.status:IN_TRANSIT': 'info',
  'Load.status:DELIVERED': 'success',
  'Load.status:CLOSED': 'success',

  // Stop.status
  'Stop.status:PENDING': 'neutral',
  'Stop.status:ARRIVED': 'brand',
  'Stop.status:COMPLETED': 'success',

  // Quote.status
  'Quote.status:OPEN': 'brand',
  'Quote.status:WON': 'success',
  'Quote.status:LOST': 'neutral',

  // Carrier.status
  'Carrier.status:PENDING': 'neutral',
  'Carrier.status:ACTIVE': 'success',
  'Carrier.status:INACTIVE': 'neutral',
  'Carrier.status:BLOCKED': 'danger',

  // Carrier.assignmentEligible (rendered as Eligible/Ineligible, always
  // shown separately from Carrier.status per Workflow 3)
  'Carrier.assignmentEligible:true': 'success',
  'Carrier.assignmentEligible:false': 'danger',

  // Customer.status
  'Customer.status:PROSPECT': 'neutral',
  'Customer.status:ACTIVE': 'success',
  'Customer.status:INACTIVE': 'neutral',
  'Customer.status:BLOCKED': 'danger',

  // Document.reviewStatus
  'Document.reviewStatus:PENDING_REVIEW': 'warning',
  'Document.reviewStatus:APPROVED': 'success',
  'Document.reviewStatus:REJECTED': 'danger',
  'Document.reviewStatus:EXPIRED': 'danger',

  // Document.scanStatus
  'Document.scanStatus:PENDING': 'neutral',
  'Document.scanStatus:CLEAN': 'success',
  'Document.scanStatus:INFECTED': 'danger',
  'Document.scanStatus:SCAN_FAILED': 'danger',

  // Document.generationStatus (Phase 16 — system-generated PDFs only)
  'Document.generationStatus:PENDING': 'neutral',
  'Document.generationStatus:COMPLETE': 'success',
  'Document.generationStatus:FAILED': 'danger',

  // Invoice.status ('OVERDUE' is computed at read time, never stored)
  'Invoice.status:DRAFT': 'neutral',
  'Invoice.status:SENT': 'brand',
  'Invoice.status:PARTIALLY_PAID': 'warning',
  'Invoice.status:PAID': 'success',
  'Invoice.status:CREDITED': 'success',
  'Invoice.status:OVERDUE': 'danger',
  'Invoice.status:VOID': 'neutral',

  // CarrierPayment.status
  'CarrierPayment.status:DRAFT': 'neutral',
  'CarrierPayment.status:PENDING_APPROVAL': 'warning',
  'CarrierPayment.status:APPROVED': 'brand',
  'CarrierPayment.status:PAID': 'success',

  // Load.podStatus (soft/warning-weight red per Workflow 7/10, not a
  // blocking-red — kept as 'danger' token, weight is a styling nuance
  // left to the Badge component's rendering, not the color mapping)
  'Load.podStatus:NOT_RECEIVED': 'danger',
  'Load.podStatus:PARTIAL': 'warning',
  'Load.podStatus:COMPLETE': 'success',

  // Load.riskStatus (NORMAL intentionally has no entry — absence of a
  // badge is the "normal" state, per §5.2.1)
  'Load.riskStatus:AT_RISK': 'warning',
  'Load.riskStatus:DELAYED': 'danger',
};

export function getStatusBadgeColor(entityField: string, value: string): BadgeColor | undefined {
  return STATUS_BADGE_MAP[`${entityField}:${value}`];
}
