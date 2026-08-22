import { notImplemented } from './notImplemented';

export interface CarrierListFilters {
  status?: string;
  assignmentEligible?: boolean;
}

/** Typed surface only — real implementations land in Phase 2. */
export const carriersApi = {
  list: (_filters?: CarrierListFilters): Promise<unknown[]> => notImplemented('carriersApi.list'),
  getById: (_id: string): Promise<unknown> => notImplemented('carriersApi.getById'),
  create: (_body: unknown): Promise<unknown> => notImplemented('carriersApi.create'),
  update: (_id: string, _body: unknown): Promise<unknown> => notImplemented('carriersApi.update'),
  addContact: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addContact'),
  addInsurance: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addInsurance'),
  recordFmcsaVerification: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.recordFmcsaVerification'),
  activate: (_id: string): Promise<unknown> => notImplemented('carriersApi.activate'),
  addServiceArea: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addServiceArea'),
  addDriver: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addDriver'),
  addTruck: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addTruck'),
  addTrailer: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.addTrailer'),
  upsertFactoring: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('carriersApi.upsertFactoring'),
  // NOTE: no cross-carrier "pending review" query exists on the backend
  // yet — the /carriers/compliance-queue screen is deferred to Phase 6
  // pending that endpoint (see the approved gap-analysis §11 item 3).
};
