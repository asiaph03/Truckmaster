/**
 * Status enum values, mirrored verbatim from backend/prisma/schema.prisma.
 * String values only — no colors here (those live in the frontend's
 * design-token layer, UI_UX_DESIGN.md §5.2.1) so this package stays
 * framework/UI-agnostic.
 */

export const LOAD_STATUSES = [
  'BOOKED',
  'CARRIER_SOURCING',
  'CARRIER_ASSIGNED',
  'RATE_CONFIRMATION',
  'DISPATCHED',
  'PICKUP',
  'IN_TRANSIT',
  'DELIVERED',
  'CLOSED',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export const STOP_STATUSES = ['PENDING', 'ARRIVED', 'COMPLETED'] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

export const QUOTE_STATUSES = ['OPEN', 'WON', 'LOST'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const CARRIER_STATUSES = ['PENDING', 'ACTIVE', 'INACTIVE', 'BLOCKED'] as const;
export type CarrierStatus = (typeof CARRIER_STATUSES)[number];

export const CUSTOMER_STATUSES = ['PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const DOCUMENT_REVIEW_STATUSES = [
  'NOT_APPLICABLE',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
] as const;
export type DocumentReviewStatus = (typeof DOCUMENT_REVIEW_STATUSES)[number];

export const DOCUMENT_SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED', 'SCAN_FAILED'] as const;
export type DocumentScanStatus = (typeof DOCUMENT_SCAN_STATUSES)[number];

export const INVOICE_STATUSES = [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'VOID',
  'CREDITED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
/** Computed at read time, never stored — Invoice.status never equals this. */
export const INVOICE_OVERDUE_PSEUDO_STATUS = 'OVERDUE' as const;

export const CARRIER_PAYMENT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID'] as const;
export type CarrierPaymentStatus = (typeof CARRIER_PAYMENT_STATUSES)[number];

export const POD_STATUSES = ['NOT_RECEIVED', 'PARTIAL', 'COMPLETE'] as const;
export type PodStatus = (typeof POD_STATUSES)[number];

export const RISK_STATUSES = ['NORMAL', 'AT_RISK', 'DELAYED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
