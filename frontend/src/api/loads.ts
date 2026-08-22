import type { EquipmentType } from '@tms/shared-constants';
import { apiRequest } from './client';
import { notImplemented } from './notImplemented';

export type LoadStatus =
  | 'BOOKED'
  | 'CARRIER_SOURCING'
  | 'CARRIER_ASSIGNED'
  | 'RATE_CONFIRMATION'
  | 'DISPATCHED'
  | 'PICKUP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CLOSED';

/**
 * Scoped-down summary — only the fields the read-only Loads tabs on
 * Customer/Carrier Detail need (approved plan §7 decision 4). Financial
 * fields are `null` when the backend has redacted them for the acting
 * role (`shapeFinancialFields`) — never render as $0.00, per the
 * approved plan's financial-visibility rule.
 */
export interface LoadSummary {
  id: string;
  loadNumber: string;
  status: LoadStatus;
  equipmentType: EquipmentType;
  customerRate: string | null;
  carrierRate?: string | null;
  createdAt: string;
}

export interface LoadListFilters {
  status?: string;
  customerId?: string;
  carrierId?: string;
}

export const loadsApi = {
  list: (filters?: LoadListFilters) => apiRequest<LoadSummary[]>('/loads', { query: filters }),

  // Typed surface only — full Load detail + every mutating action lands
  // in Phase 3 (Load lifecycle screens / Dispatch Board), not Phase 2.
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
  // alongside the Calendar view, not a Phase 2 concern.
};
