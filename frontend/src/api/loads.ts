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

export type StopType = 'PICKUP' | 'DELIVERY' | 'OTHER';
export type StopStatus = 'PENDING' | 'ARRIVED' | 'COMPLETED';
export type SourcingAttemptOutcome =
  'ASSIGNED' | 'DECLINED' | 'NO_RESPONSE' | 'QUOTED' | 'REJECTED_AFTER_ASSIGNMENT';
export type CheckCallOnTimeStatus = 'ON_TIME' | 'LATE' | 'UNKNOWN';
export type RiskStatus = 'NORMAL' | 'AT_RISK' | 'DELAYED';
export type PodStatus = 'NOT_RECEIVED' | 'PARTIAL' | 'COMPLETE';
export type RateSource = 'MANUAL' | 'RATE_AGREEMENT' | 'MANUAL_OVERRIDE';
export type BookingSource = 'QUOTE' | 'DIRECT';

export interface Stop {
  id: string;
  loadId: string;
  sequence: number;
  stopType: StopType;
  customerLocationId?: string;
  addressLine1?: string;
  city: string;
  state: string;
  zip: string;
  appointmentDatetime?: string;
  actualArrival?: string;
  actualDeparture?: string;
  status: StopStatus;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
  /** Only present on GET /loads/:id, not the list endpoint. */
  hasPod?: boolean;
}

export interface CarrierSourcingAttempt {
  id: string;
  loadId: string;
  carrierId: string;
  carrierRate?: string;
  outcome: SourcingAttemptOutcome;
  rejectionReason?: string;
  loggedByUserId: string;
  loggedAt: string;
}

export interface DispatchRecord {
  loadId: string;
  driverName: string;
  driverPhone: string;
  truckNumber: string;
  trailerNumber: string;
  sourceDriverId?: string;
  sourceTruckId?: string;
  sourceTrailerId?: string;
  dispatchedByUserId: string;
  dispatchedAt: string;
  updatedAt: string;
}

export interface CheckCall {
  id: string;
  loadId: string;
  loggedByUserId: string;
  occurredAt: string;
  contactMethod: string;
  personContacted: string;
  locationCity?: string;
  locationState?: string;
  locationZip?: string;
  eta?: string;
  onTimeStatus: CheckCallOnTimeStatus;
  notes?: string;
}

/**
 * Full Load detail — `GET /loads/:id` include shape confirmed against
 * `LoadService.findById`: stops, sourcingAttempts, dispatchRecord,
 * checkCalls. Does NOT include chargeLineItems — no read endpoint
 * exists for those (approved plan §6 gap 1); the Financials tab is
 * deferred, not worked around.
 */
export interface Load {
  id: string;
  loadNumber: string;
  customerId: string;
  bookingSource: BookingSource;
  quoteId?: string;
  status: LoadStatus;
  equipmentType: EquipmentType;
  // Nullable when redacted server-side for the acting role
  // (shapeFinancialFields) — never render as $0.00.
  customerRate: string | null;
  rateSource: RateSource | null;
  rateAgreementId: string | null;
  customerPoNumber?: string;
  bolNumber?: string;
  pickupNumber?: string;
  customerReferenceNumber?: string;
  assignedCarrierId?: string;
  carrierRate?: string | null;
  assignedDispatcherId?: string;
  podStatus: PodStatus;
  riskStatus: RiskStatus;
  riskReason?: string;
  invoiced: boolean;
  closedAt?: string;
  closedByUserId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  stops: Stop[];
  sourcingAttempts: CarrierSourcingAttempt[];
  dispatchRecord: DispatchRecord | null;
  checkCalls: CheckCall[];
}

/**
 * `GET /loads` list-row shape. Now includes `stops` — a Phase 3 gap-fix
 * (approved, see loads.service.ts) so the Dispatch Board Table View can
 * render Origin/Destination + Pickup/Delivery Date without an N+1 fetch
 * per row. Also doubles as the read-only Loads tabs' row shape on
 * Customer/Carrier Detail (Phase 2 §7 decision 4) — a strict subset of
 * these fields.
 */
export interface LoadSummary {
  id: string;
  loadNumber: string;
  customerId: string;
  status: LoadStatus;
  equipmentType: EquipmentType;
  customerRate: string | null;
  carrierRate?: string | null;
  assignedCarrierId?: string;
  assignedDispatcherId?: string;
  riskStatus: RiskStatus;
  podStatus: PodStatus;
  createdAt: string;
  stops: Stop[];
}

export interface LoadListFilters {
  status?: string;
  customerId?: string;
  carrierId?: string;
  dispatcherId?: string;
  equipmentType?: string;
}

export interface LoadStopInput {
  sequence: number;
  stopType: StopType;
  customerLocationId?: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  appointmentDatetime?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface CreateLoadRequest {
  customerId: string;
  stops: LoadStopInput[];
  equipmentType: EquipmentType;
  customerRate: string;
  customerPoNumber?: string;
  bolNumber?: string;
  pickupNumber?: string;
  customerReferenceNumber?: string;
  confirmInactiveCustomerOverride?: boolean;
}

export interface UpdateLoadReferenceNumbersRequest {
  customerPoNumber?: string;
  bolNumber?: string;
  pickupNumber?: string;
  customerReferenceNumber?: string;
}

export interface LogSourcingAttemptRequest {
  carrierId: string;
  outcome: 'DECLINED' | 'NO_RESPONSE' | 'QUOTED';
  carrierRate?: string;
}

export interface AssignCarrierRequest {
  carrierId: string;
  carrierRate: string;
}

export interface CarrierRejectedRequest {
  reason: string;
}

export interface GenerateRateConfirmationRequest {
  sendEmail?: boolean;
}

export interface DispatchLoadRequest {
  driverName: string;
  driverPhone: string;
  truckNumber: string;
  trailerNumber: string;
  sourceDriverId?: string;
  sourceTruckId?: string;
  sourceTrailerId?: string;
}

export type UpdateDispatchRequest = Partial<DispatchLoadRequest>;

export interface StopTimestampRequest {
  timestamp?: string;
}

export interface LogCheckCallRequest {
  occurredAt?: string;
  contactMethod: string;
  personContacted: string;
  locationCity?: string;
  locationState?: string;
  locationZip?: string;
  eta?: string;
  onTimeStatus: CheckCallOnTimeStatus;
  notes?: string;
}

export interface SetRiskStatusRequest {
  riskStatus: RiskStatus;
  riskReason?: string;
}

export interface AssignDispatcherRequest {
  dispatcherUserId: string;
}

/**
 * `EligibilityError`'s (409) `details.reasons` shape — surfaced verbatim
 * from `CarrierEligibilityService.recalculate`, same reason strings
 * already used by Carrier Detail's `EligibilityBadge` (Phase 2).
 */
export interface EligibilityErrorDetails {
  reasons: string[];
}

export const loadsApi = {
  list: (filters?: LoadListFilters) => apiRequest<LoadSummary[]>('/loads', { query: filters }),

  getById: (id: string) => apiRequest<Load>(`/loads/${id}`),

  create: (body: CreateLoadRequest) => apiRequest<Load>('/loads', { method: 'POST', body }),

  update: (id: string, body: UpdateLoadReferenceNumbersRequest) =>
    apiRequest<Load>(`/loads/${id}`, { method: 'PATCH', body }),

  beginSourcing: (id: string) =>
    apiRequest<Load>(`/loads/${id}/begin-sourcing`, { method: 'POST' }),

  logSourcingAttempt: (id: string, body: LogSourcingAttemptRequest) =>
    apiRequest<CarrierSourcingAttempt>(`/loads/${id}/sourcing-attempts`, { method: 'POST', body }),

  assignCarrier: (id: string, body: AssignCarrierRequest) =>
    apiRequest<Load>(`/loads/${id}/assign-carrier`, { method: 'POST', body }),

  carrierRejected: (id: string, body: CarrierRejectedRequest) =>
    apiRequest<Load>(`/loads/${id}/carrier-rejected`, { method: 'POST', body }),

  generateRateConfirmation: (id: string, body?: GenerateRateConfirmationRequest) =>
    apiRequest<Load>(`/loads/${id}/generate-rate-confirmation`, { method: 'POST', body }),

  dispatch: (id: string, body: DispatchLoadRequest) =>
    apiRequest<Load>(`/loads/${id}/dispatch`, { method: 'POST', body }),

  updateDispatch: (id: string, body: UpdateDispatchRequest) =>
    apiRequest<DispatchRecord>(`/loads/${id}/dispatch`, { method: 'PATCH', body }),

  recordStopArrival: (id: string, sequence: number, body?: StopTimestampRequest) =>
    apiRequest<{ stop: Stop; load: Load }>(`/loads/${id}/stops/${sequence}/arrival`, {
      method: 'POST',
      body,
    }),

  recordStopDeparture: (id: string, sequence: number, body?: StopTimestampRequest) =>
    apiRequest<{ stop: Stop; load: Load }>(`/loads/${id}/stops/${sequence}/departure`, {
      method: 'POST',
      body,
    }),

  logCheckCall: (id: string, body: LogCheckCallRequest) =>
    apiRequest<CheckCall>(`/loads/${id}/check-calls`, { method: 'POST', body }),

  setRiskStatus: (id: string, body: SetRiskStatusRequest) =>
    apiRequest<Load>(`/loads/${id}/risk-status`, { method: 'PATCH', body }),

  setDispatcher: (id: string, body: AssignDispatcherRequest) =>
    apiRequest<Load>(`/loads/${id}/dispatcher`, { method: 'PATCH', body }),

  // Typed surface only — deferred per the approved Phase 3 plan §7
  // decision 2 (Financials tab / Load Closing screen not built this
  // phase: no GET endpoint exists for a Load's charge line items, and
  // closing has no checklist-preview path separate from actually
  // closing).
  readyToInvoice: (_customerId?: string): Promise<unknown[]> =>
    notImplemented('loadsApi.readyToInvoice'),
  addCharge: (_id: string, _body: unknown): Promise<unknown> =>
    notImplemented('loadsApi.addCharge'),
  close: (_id: string): Promise<unknown> => notImplemented('loadsApi.close'),
  // NOTE: PATCH /loads/:id/stops/:seq (appointment reschedule) does not
  // exist on the backend yet — deferred alongside the Calendar view
  // (§7 decision 1), not built or stubbed here.
};
