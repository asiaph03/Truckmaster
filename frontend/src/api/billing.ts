import { notImplemented } from './notImplemented';

export interface InvoiceListFilters {
  customerId?: string;
  status?: string;
}

/** Typed surface only — real implementations land in Phase 4 (Financials). */
export const billingApi = {
  listChargeTypes: (): Promise<unknown[]> => notImplemented('billingApi.listChargeTypes'),
  createChargeType: (_body: unknown): Promise<unknown> =>
    notImplemented('billingApi.createChargeType'),
  updateChargeType: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.updateChargeType'),
  listInvoices: (_filters?: InvoiceListFilters): Promise<unknown[]> =>
    notImplemented('billingApi.listInvoices'),
  getInvoiceById: (_id: string): Promise<unknown> => notImplemented('billingApi.getInvoiceById'),
  createInvoice: (_body: unknown): Promise<unknown> => notImplemented('billingApi.createInvoice'),
  sendInvoice: (_id: string): Promise<unknown> => notImplemented('billingApi.sendInvoice'),
  recordPayment: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.recordPayment'),
  addAdjustment: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('billingApi.addAdjustment'),
  voidInvoice: (_id: string): Promise<unknown> => notImplemented('billingApi.voidInvoice'),
};
