import { apiRequest } from './client';

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'VOID' | 'CREDITED';
export type AdjustmentType = 'CREDIT' | 'DEBIT';

export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  description: string;
  amount: string;
  sourceLoadId?: string;
  sourceChargeLineItemId?: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: string;
  paymentDate: string;
  method: string;
  referenceNumber?: string;
  notes?: string;
  createdAt: string;
}

export interface Adjustment {
  id: string;
  invoiceId: string;
  type: AdjustmentType;
  amount: string;
  reason: string;
  adjustmentDate: string;
  createdAt: string;
}

export interface InvoiceLoad {
  id: string;
  invoiceId: string;
  loadId: string;
  loadTotalAtInvoice: string;
}

export interface ChargeTypeDefinition {
  id: string;
  organizationId: string | null;
  code: string;
  label: string;
  isSystemDefault: boolean;
}

export interface InvoiceListFilters {
  customerId?: string;
  status?: string;
}

/**
 * `GET /invoices` row shape. `total`/`remainingBalance`/`dueDate` come
 * back `null` from the backend for a Sales/Booking caller viewing a
 * non-own-deal invoice — never render as $0.00. Same shape used by
 * Customer Detail's read-only Invoices tab (Phase 2) and the new
 * standalone Invoice List page.
 */
export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  customerId: string;
  customer?: { id: string; legalName: string };
  total: string | null;
  remainingBalance: string | null;
  dueDate: string | null;
  createdAt: string;
}

/** `GET /invoices/:id` — full detail, includes every child relation. */
export interface Invoice extends InvoiceSummary {
  createdByUserId: string;
  sentAt?: string;
  lineItems: InvoiceLineItem[];
  payments: Payment[];
  adjustments: Adjustment[];
  invoiceLoads: InvoiceLoad[];
}

export interface CreateInvoiceRequest {
  customerId: string;
  loadIds: string[];
  podWarningAcknowledged?: boolean;
}

export interface SendInvoiceRequest {
  recipientEmail: string;
  subject: string;
  message: string;
}

export interface RecordPaymentRequest {
  amount: string;
  paymentDate: string;
  method: string;
  referenceNumber?: string;
  notes?: string;
}

export interface AddAdjustmentRequest {
  type: AdjustmentType;
  amount: string;
  reason: string;
  adjustmentDate?: string;
}

export interface RecordPaymentResponse {
  payment: Payment;
  remainingBalance: string;
  status: InvoiceStatus;
}

export interface AddAdjustmentResponse {
  adjustment: Adjustment;
  remainingBalance: string;
  status: InvoiceStatus;
}

/**
 * `PodIncompleteWarningError`'s (409, code `POD_INCOMPLETE_WARNING`)
 * `details` shape — Workflow 8 §8.2. Resubmit `POST /invoices` with
 * `podWarningAcknowledged: true` to proceed.
 */
export interface PodIncompleteWarningDetails {
  affectedLoads: string[];
}

export const billingApi = {
  listInvoices: (filters?: InvoiceListFilters) =>
    apiRequest<InvoiceSummary[]>('/invoices', { query: filters }),

  getInvoiceById: (id: string) => apiRequest<Invoice>(`/invoices/${id}`),

  createInvoice: (body: CreateInvoiceRequest) =>
    apiRequest<Invoice>('/invoices', { method: 'POST', body }),

  sendInvoice: (id: string, body: SendInvoiceRequest) =>
    apiRequest<Invoice>(`/invoices/${id}/send`, { method: 'POST', body }),

  recordPayment: (id: string, body: RecordPaymentRequest) =>
    apiRequest<RecordPaymentResponse>(`/invoices/${id}/payments`, { method: 'POST', body }),

  addAdjustment: (id: string, body: AddAdjustmentRequest) =>
    apiRequest<AddAdjustmentResponse>(`/invoices/${id}/adjustments`, { method: 'POST', body }),

  voidInvoice: (id: string) => apiRequest<Invoice>(`/invoices/${id}/void`, { method: 'POST' }),

  listChargeTypes: () => apiRequest<ChargeTypeDefinition[]>('/charge-types'),

  createChargeType: (body: { code: string; label: string }) =>
    apiRequest<ChargeTypeDefinition>('/charge-types', { method: 'POST', body }),

  updateChargeType: (id: string, body: { label: string }) =>
    apiRequest<ChargeTypeDefinition>(`/charge-types/${id}`, { method: 'PATCH', body }),
};
