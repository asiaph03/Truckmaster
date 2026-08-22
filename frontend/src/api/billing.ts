import { apiRequest } from './client';
import { notImplemented } from './notImplemented';

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'VOID' | 'CREDITED';

export interface InvoiceListFilters {
  customerId?: string;
  status?: string;
}

/**
 * Scoped-down summary — only what Customer Detail's read-only Invoices
 * tab needs (approved plan §7 decision 4), not the full Invoice Builder/
 * Detail screens (Phase 4). `total`/`remainingBalance` come back `null`
 * from the backend for a Sales/Booking caller viewing a non-own-deal
 * invoice — never render as $0.00.
 */
export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  total: string | null;
  remainingBalance: string | null;
  dueDate: string | null;
}

export const billingApi = {
  listInvoices: (filters?: InvoiceListFilters) =>
    apiRequest<InvoiceSummary[]>('/invoices', { query: filters }),

  // Typed surface only — full Invoice Builder/Detail + every mutating
  // action lands in Phase 4 (Financials), not Phase 2.
  listChargeTypes: (): Promise<unknown[]> => notImplemented('billingApi.listChargeTypes'),
  createChargeType: (_body: unknown): Promise<unknown> =>
    notImplemented('billingApi.createChargeType'),
  updateChargeType: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.updateChargeType'),
  getInvoiceById: (_id: string): Promise<unknown> => notImplemented('billingApi.getInvoiceById'),
  createInvoice: (_body: unknown): Promise<unknown> => notImplemented('billingApi.createInvoice'),
  sendInvoice: (_id: string): Promise<unknown> => notImplemented('billingApi.sendInvoice'),
  recordPayment: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.recordPayment'),
  addAdjustment: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.addAdjustment'),
  voidInvoice: (_id: string): Promise<unknown> => notImplemented('billingApi.voidInvoice'),
};
