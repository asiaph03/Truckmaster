import { notImplemented } from './notImplemented';

export interface LoadListFilters {
  status?: string;
  customerId?: string;
}

/** Typed surface only — real implementations land in Phase 3 (Load lifecycle screens). */
export const loadsApi = {
  list: (_filters?: LoadListFilters): Promise<unknown[]> => notImplemented('loadsApi.list'),
  getById: (_id: string): Promise<unknown> => notImplemented('loadsApi.getById'),
  readyToInvoice: (_customerId?: string): Promise<unknown[]> =>
    notImplemented('loadsApi.readyToInvoice'),
  create: (_body: unknown): Promise<unknown> => notImplemented('loadsApi.create'),
  update: (_id: string, _body: unknown): Promise<unknown> => notImplemented('loadsApi.update'),
  beginSourcing: (_id: string): Promise<unknown> => notImplemented('loadsApi.beginSourcing'),
  logSourcingAttempt: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.logSourcingAttempt'),
  assignCarrier: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.assignCarrier'),
  carrierRejected: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.carrierRejected'),
  generateRateConfirmation: (_id: string): Promise<unknown> =>
    notImplemented('loadsApi.generateRateConfirmation'),
  dispatch: (_id: string, _body: unknown): Promise<unknown> => notImplemented('loadsApi.dispatch'),
  updateDispatch: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.updateDispatch'),
  recordStopArrival: (_id: string, _sequence: number): Promise<unknown> =>
    notImplemented('loadsApi.recordStopArrival'),
  recordStopDeparture: (_id: string, _sequence: number): Promise<unknown> =>
    notImplemented('loadsApi.recordStopDeparture'),
  logCheckCall: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.logCheckCall'),
  setRiskStatus: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.setRiskStatus'),
  setDispatcher: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.setDispatcher'),
  addCharge: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.addCharge'),
  close: (_id: string): Promise<unknown> => notImplemented('loadsApi.close'),
  // NOTE: PATCH /loads/:id/stops/:seq (appointment reschedule) does not
  // exist on the backend yet — approved as a small Phase 3 addition
  // alongside the Calendar view, not a Phase 1 concern.
};
