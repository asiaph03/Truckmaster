import { notImplemented } from './notImplemented';

export interface CustomerListFilters {
  status?: string;
  search?: string;
}

/** Typed surface only — real implementations land in Phase 2. */
export const customersApi = {
  list: (_filters?: CustomerListFilters): Promise<unknown[]> => notImplemented('customersApi.list'),
  getById: (_id: string): Promise<unknown> => notImplemented('customersApi.getById'),
  create: (_body: unknown): Promise<unknown> => notImplemented('customersApi.create'),
  update: (_id: string, _body: unknown): Promise<unknown> => notImplemented('customersApi.update'),
  setStatus: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('customersApi.setStatus'),
  addContact: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('customersApi.addContact'),
  addLocation: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('customersApi.addLocation'),
  addRateAgreement: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('customersApi.addRateAgreement'),
};
