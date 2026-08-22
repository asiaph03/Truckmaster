import { notImplemented } from './notImplemented';

export interface CarrierPaymentListFilters {
  loadId?: string;
  status?: string;
}

/** Typed surface only — real implementations land in Phase 4 (Financials). */
export const carrierPayApi = {
  create: (_loadId: string, _body: unknown): Promise<unknown> =>
    notImplemented('carrierPayApi.create'),
  list: (_filters?: CarrierPaymentListFilters): Promise<unknown[]> =>
    notImplemented('carrierPayApi.list'),
  getById: (_id: string): Promise<unknown> => notImplemented('carrierPayApi.getById'),
  submit: (_id: string): Promise<unknown> => notImplemented('carrierPayApi.submit'),
  approve: (_id: string): Promise<unknown> => notImplemented('carrierPayApi.approve'),
  reject: (_id: string, _body: unknown): Promise<unknown> => notImplemented('carrierPayApi.reject'),
  markPaid: (_id: string): Promise<unknown> => notImplemented('carrierPayApi.markPaid'),
};
