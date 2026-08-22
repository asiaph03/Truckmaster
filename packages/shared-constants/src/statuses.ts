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

/**
 * Frontend Phase 2 additions — form/picker enums, mirrored verbatim from
 * backend/prisma/schema.prisma the same way the status enums above are.
 * Not status/badge values, but the same "single re-declared source of
 * truth" reasoning applies: these back Select options on the Customer/
 * Carrier creation and detail forms.
 */

export const PAYMENT_TERMS = ['DUE_ON_RECEIPT', 'NET_15', 'NET_30', 'NET_45', 'NET_60'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

export const CUSTOMER_CONTACT_ROLES = [
  'BOOKING',
  'OPERATIONS',
  'BILLING',
  'MANAGEMENT',
  'OTHER',
] as const;
export type CustomerContactRole = (typeof CUSTOMER_CONTACT_ROLES)[number];

export const CUSTOMER_LOCATION_TYPES = ['PICKUP', 'DELIVERY', 'OTHER'] as const;
export type CustomerLocationType = (typeof CUSTOMER_LOCATION_TYPES)[number];

export const CARRIER_CONTACT_ROLES = [
  'DISPATCH',
  'SAFETY_COMPLIANCE',
  'BILLING',
  'FACTORING',
  'MANAGEMENT',
  'OTHER',
] as const;
export type CarrierContactRole = (typeof CARRIER_CONTACT_ROLES)[number];

export const EQUIPMENT_TYPES = ['DRY_VAN', 'REEFER', 'FLATBED'] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const INSURANCE_COVERAGE_TYPES = ['AUTO_LIABILITY', 'CARGO'] as const;
export type InsuranceCoverageType = (typeof INSURANCE_COVERAGE_TYPES)[number];

export const CARRIER_SERVICE_AREA_TYPES = ['LANE', 'REGION'] as const;
export type CarrierServiceAreaType = (typeof CARRIER_SERVICE_AREA_TYPES)[number];

export const DOCUMENT_TYPE_CATEGORIES = ['LOAD', 'CARRIER_COMPLIANCE'] as const;
export type DocumentTypeCategory = (typeof DOCUMENT_TYPE_CATEGORIES)[number];

/**
 * FMCSA verification `resultStatus` — the backend field is free text
 * (only `"authorized"`, case-insensitive, is treated as eligibility-
 * passing), but the frontend renders a fixed picker for data quality
 * per the approved Phase 2 plan §7 decision 5. `OTHER` pairs with a
 * free-text field in the form; its value is sent as-is, not the literal
 * string `"OTHER"`.
 */
export const FMCSA_RESULT_STATUS_OPTIONS = [
  'Authorized',
  'Conditional',
  'Not Authorized',
  'OTHER',
] as const;
export type FmcsaResultStatusOption = (typeof FMCSA_RESULT_STATUS_OPTIONS)[number];
