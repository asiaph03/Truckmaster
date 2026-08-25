import type { EquipmentType } from '@tms/shared-constants';
import { apiRequest } from './client';

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

export type ChargeLineItemSide = 'CUSTOMER' | 'CARRIER';
export type ChargeLineItemSource = 'ORIGINAL' | 'ADJUSTMENT';

export interface ChargeLineItem {
  id: string;
  loadId: string;
  side: ChargeLineItemSide;
  chargeTypeId: string;
  description?: string;
  quantity: string;
  unitRate: string;
  // Nullable when redacted server-side per its own `side` — a CUSTOMER
  // charge follows customerRate visibility, a CARRIER charge follows
  // carrierRate visibility (Frontend Phase 4 gap-fix). Never render as
  // $0.00.
  amount: string | null;
  source: ChargeLineItemSource;
  notes?: string;
  createdByUserId: string;
  createdAt: string;
}

export interface ClosingChecklistItem {
  item: string;
  status: 'CLEAN' | 'WARNING';
  detail: string;
  remainingCarrierBalance?: string;
}

/**
 * Full Load detail — `GET /loads/:id` include shape confirmed against
 * `LoadService.findById`: stops, sourcingAttempts, dispatchRecord,
 * checkCalls, chargeLineItems (Frontend Phase 4 gap-fix — the Financials
 * tab's itemized Customer/Carrier-side table).
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
  chargeLineItems: ChargeLineItem[];
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

/**
 * `GET /loads/ready-to-invoice` row shape — every scalar `Load` field
 * plus `customer` and the full `chargeLineItems` array, plus a computed
 * `customerChargesTotal`. Gated to `viewLoadFinancials` roles only at
 * the guard level, so redaction never actually applies to a caller who
 * can reach this endpoint — fields are typed non-null accordingly.
 */
export interface ReadyToInvoiceLoad {
  id: string;
  loadNumber: string;
  customerId: string;
  customer: { id: string; legalName: string };
  status: LoadStatus;
  equipmentType: EquipmentType;
  customerRate: string;
  carrierRate: string | null;
  podStatus: PodStatus;
  chargeLineItems: ChargeLineItem[];
  customerChargesTotal: string;
  createdAt: string;
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

/** Frontend Phase 6 approved gap-fix — Dispatch Board Calendar drag-to-reschedule. */
export interface RescheduleStopRequest {
  appointmentDatetime: string;
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

export interface AddChargeRequest {
  side: ChargeLineItemSide;
  chargeTypeId: string;
  description?: string;
  quantity?: string;
  unitRate: string;
  notes?: string;
}

export interface CloseLoadResponse {
  load: Load;
  checklistSnapshot: ClosingChecklistItem[];
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

  /**
   * Frontend Phase 6 approved gap-fix — Dispatch Board Calendar's
   * drag-to-reschedule (Decision DB-C-4). Server re-validates the
   * PENDING-stop / not-DELIVERED-or-CLOSED-Load restriction regardless
   * of what the UI offers.
   */
  rescheduleStop: (id: string, sequence: number, body: RescheduleStopRequest) =>
    apiRequest<Stop>(`/loads/${id}/stops/${sequence}/reschedule`, { method: 'PATCH', body }),

  logCheckCall: (id: string, body: LogCheckCallRequest) =>
    apiRequest<CheckCall>(`/loads/${id}/check-calls`, { method: 'POST', body }),

  setRiskStatus: (id: string, body: SetRiskStatusRequest) =>
    apiRequest<Load>(`/loads/${id}/risk-status`, { method: 'PATCH', body }),

  setDispatcher: (id: string, body: AssignDispatcherRequest) =>
    apiRequest<Load>(`/loads/${id}/dispatcher`, { method: 'PATCH', body }),

  readyToInvoice: (customerId?: string) =>
    apiRequest<ReadyToInvoiceLoad[]>('/loads/ready-to-invoice', { query: { customerId } }),

  addCharge: (id: string, body: AddChargeRequest) =>
    apiRequest<ChargeLineItem>(`/loads/${id}/charges`, { method: 'POST', body }),

  close: (id: string) => apiRequest<CloseLoadResponse>(`/loads/${id}/close`, { method: 'POST' }),

  /** Frontend Phase 4 gap-fix — read-only preview of the same checklist `close` computes. */
  getClosingChecklist: (id: string) =>
    apiRequest<{ checklist: ClosingChecklistItem[] }>(`/loads/${id}/closing-checklist`),
};
