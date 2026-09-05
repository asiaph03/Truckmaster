import type { EquipmentType } from '@tms/shared-constants';
import { API_BASE, apiRequest } from './client';
import { ApiError } from './errors';

export type LoadStatus =
  | 'BOOKED'
  | 'CARRIER_SOURCING'
  | 'CARRIER_ASSIGNED'
  | 'RATE_CONFIRMATION'
  | 'DISPATCHED'
  | 'PICKUP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CLOSED'
  | 'CANCELLED';

export type StopType = 'PICKUP' | 'DELIVERY' | 'OTHER';
export type StopStatus = 'PENDING' | 'ARRIVED' | 'COMPLETED';
/** Return Product feature — orthogonal to StopType; a RETURN pickup still uses POP, a RETURN delivery still uses POD. */
export type StopPurpose = 'STANDARD' | 'RETURN';
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
  stopPurpose: StopPurpose;
  customerLocationId?: string;
  // Authoritative pickup/delivery company name for this stop. Nullable —
  // pre-existing and Quote-converted stops never had one captured.
  companyName: string | null;
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
  cancelledAt?: string;
  cancelledByUserId?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  stops: Stop[];
  sourcingAttempts: CarrierSourcingAttempt[];
  dispatchRecord: DispatchRecord | null;
  checkCalls: CheckCall[];
  chargeLineItems: ChargeLineItem[];
  // Return Product feature — set only when this Load itself exists
  // because of a return that couldn't stay on the original Load.
  returnForLoadId?: string;
  returnForLoad?: { id: string; loadNumber: string } | null;
  // Loads that point back at this one as their returnForLoad.
  returnLoads?: { id: string; loadNumber: string; status: LoadStatus }[];
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
  /**
   * Dispatch Board Driver visibility — resolved server-side
   * (LoadService.list): the live sourceDriver's current name when the
   * dispatch is linked to a real Driver record, else the DispatchRecord's
   * own snapshotted driverName for a manually-typed dispatch, else `null`
   * when the Load has never been dispatched. Render `null` as
   * "Unassigned" — never displayed as a raw null/empty string.
   */
  assignedDriverName: string | null;
}

export interface LoadListFilters {
  status?: string;
  customerId?: string;
  carrierId?: string;
  dispatcherId?: string;
  equipmentType?: string;
}

export type LoadSearchSort = 'loadNumber' | 'pickupDate' | 'deliveryDate';
export type LoadSearchSortDirection = 'asc' | 'desc';

/**
 * Frontend Phase 13 — a dedicated `GET /loads/search` request shape, kept
 * separate from `LoadListFilters` above: Load Search adds riskStatus,
 * date-range, free-text, sort, and pagination params that `GET /loads`
 * (Dispatch Board) deliberately does not carry, per the approved plan's
 * decision not to touch `GET /loads`'s existing shape/behavior at all.
 */
export interface LoadSearchFilters {
  status?: string;
  customerId?: string;
  carrierId?: string;
  dispatcherId?: string;
  equipmentType?: string;
  riskStatus?: RiskStatus;
  pickupFrom?: string;
  pickupTo?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  q?: string;
  sort?: LoadSearchSort;
  sortDirection?: LoadSearchSortDirection;
  page?: number;
  pageSize?: number;
  /** Frontend Phase 18 — export-only, Dispatch Board's "Export Selected." */
  ids?: string[];
  /** Frontend Phase 18 — export-only, Dispatch Board's default "excl. Closed" state. */
  excludeClosed?: boolean;
}

/** Row shape is identical to `GET /loads`'s `LoadSummary` — same bare-Load-plus-stops shape, same redaction. */
export interface LoadSearchResult {
  items: LoadSummary[];
  total: number;
  page: number;
  pageSize: number;
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
  companyName: string;
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

export interface CancelLoadRequest {
  reason: string;
}

export interface GenerateRateConfirmationRequest {
  sendEmail?: boolean;
}

/**
 * Driver Dispatch Email feature — read-only preview, backed by the exact
 * same deterministic formatter/recipient-resolution the send action uses
 * server-side, so this is always byte-identical to what would be sent.
 */
export interface DriverDispatchEmailPreview {
  recipientEmail: string | null;
  subject: string;
  body: string;
  attachmentAvailable: boolean;
  attachmentFileName: string | null;
}

export interface SendDriverDispatchEmailRequest {
  /** One-time override only — used (and required) when no on-file driver email exists; never persisted. */
  manualRecipientEmail?: string;
  /**
   * Required — the server is the actual gate, never just the frontend
   * checkbox. When true, the original uploaded Rate Confirmation PDF
   * must resolve and validate or the send fails; when false, no
   * attachment is looked up or queued at all (never falls back to the
   * generated Rate Confirmation either way).
   */
  attachRateConfirmation: boolean;
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

/**
 * Load Detail's Edit Stops action — `sequence` identifies which existing
 * Stop this item targets (never itself changed). Full-replace semantics:
 * an absent optional field clears it, matching UpdateStopItemDto on the
 * backend.
 */
export interface UpdateStopItemRequest {
  sequence: number;
  stopType: StopType;
  companyName: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  appointmentDatetime?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface UpdateStopsRequest {
  stops: UpdateStopItemRequest[];
}

/**
 * Return Product feature — "Initiate Return" modal's per-stop input.
 * `sequence`/`stopType` are never caller-supplied — both stops are always
 * PICKUP/RETURN then DELIVERY/RETURN at the next two sequence numbers,
 * resolved server-side.
 */
export interface ReturnStopInput {
  customerLocationId?: string;
  companyName: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  appointmentDatetime?: string;
  contactName?: string;
  contactPhone?: string;
  notes?: string;
}

export interface InitiateReturnRequest {
  pickupStop: ReturnStopInput;
  deliveryStop: ReturnStopInput;
}

/** Return Product feature — the post-creation "link to original Load" action. */
export interface LinkReturnLoadRequest {
  returnForLoadId: string;
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
  /** Task #8 — `null` explicitly unassigns; the field must still be present. */
  dispatcherUserId: string | null;
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

/**
 * Frontend Phase 18 — `ids` needs array-aware serialization (repeated
 * `ids=a&ids=b` keys, verified directly against the backend's `qs` query
 * parser — a comma-joined single value would NOT be parsed as an array).
 * `excludeClosed` is an optional flag: only ever sent when `true`, never
 * as a literal `excludeClosed=false`.
 */
function buildSearchQueryString(filters: LoadSearchFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (typeof value === 'boolean') {
      if (value) params.set(key, 'true');
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export const loadsApi = {
  list: (filters?: LoadListFilters) => apiRequest<LoadSummary[]>('/loads', { query: filters }),

  search: (filters: LoadSearchFilters) =>
    apiRequest<LoadSearchResult>('/loads/search', { query: filters }),

  /**
   * Not routed through `apiRequest` — that helper always parses a JSON
   * body, but this endpoint returns a raw CSV file. Triggers a normal
   * browser file download via a throwaway object URL, same approach any
   * static file download would use; no new library needed.
   */
  exportSearchCsv: async (filters: LoadSearchFilters): Promise<void> => {
    const qs = buildSearchQueryString(filters);
    const response = await fetch(`${API_BASE}/loads/search/export${qs ? `?${qs}` : ''}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new ApiError(
        response.status,
        payload?.error ?? { code: 'INTERNAL_ERROR', message: 'Export failed' },
      );
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'load-search-export.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

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

  previewDriverDispatchEmail: (id: string) =>
    apiRequest<DriverDispatchEmailPreview>(`/loads/${id}/driver-dispatch-email-preview`),

  sendDriverDispatchEmail: (id: string, body: SendDriverDispatchEmailRequest) =>
    apiRequest<{ recipientEmail: string }>(`/loads/${id}/send-driver-dispatch-email`, {
      method: 'POST',
      body,
    }),

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

  /**
   * Load Detail's Edit Stops action — one atomic call for the whole
   * batch (never one request per stop): the backend runs every stop's
   * update inside a single transaction, rolling back entirely if any
   * item fails lookup/validation.
   */
  updateStops: (id: string, body: UpdateStopsRequest) =>
    apiRequest<{ stops: Stop[]; load: Load }>(`/loads/${id}/stops`, { method: 'PATCH', body }),

  /**
   * Return Product feature — appends one PICKUP/RETURN + one
   * DELIVERY/RETURN stop pair to this Load at the next two sequence
   * numbers. Works after DELIVERED (the common real-world timing);
   * rejected server-side on a CLOSED Load or before DISPATCHED.
   */
  initiateReturn: (id: string, body: InitiateReturnRequest) =>
    apiRequest<{ stops: Stop[]; load: Load }>(`/loads/${id}/stops/return`, {
      method: 'POST',
      body,
    }),

  /** Return Product feature — the post-creation "link to original Load" action for a separate return Load. */
  linkReturnLoad: (id: string, body: LinkReturnLoadRequest) =>
    apiRequest<Load>(`/loads/${id}/link-return`, { method: 'PATCH', body }),

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

  cancelLoad: (id: string, body: CancelLoadRequest) =>
    apiRequest<Load>(`/loads/${id}/cancel`, { method: 'POST', body }),
};
