import type {
  CarrierContactRole,
  CarrierServiceAreaType,
  EquipmentType,
  InsuranceCoverageType,
} from '@tms/shared-constants';
import { apiRequest } from './client';

export type CarrierStatus = 'PENDING' | 'ACTIVE' | 'INACTIVE' | 'BLOCKED';

export interface CarrierContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  role: CarrierContactRole;
  isPrimary: boolean;
}

export interface CarrierInsuranceRecord {
  id: string;
  coverageType: InsuranceCoverageType;
  coverageAmount: string;
  insuranceCompany: string;
  agentContact?: string;
  effectiveDate: string;
  expirationDate: string;
  coiDocumentId: string;
}

export interface CarrierFmcsaVerification {
  id: string;
  verificationDate: string;
  resultStatus: string;
  authorityInfo?: string;
  notes?: string;
  verifiedByUserId: string;
}

export interface CarrierServiceArea {
  id: string;
  type: CarrierServiceAreaType;
  originCity?: string;
  originState?: string;
  destinationCity?: string;
  destinationState?: string;
  regionLabel?: string;
  notes?: string;
}

export interface CarrierDriver {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  licenseNumber?: string;
  notes?: string;
  active: boolean;
}

export interface CarrierTruck {
  id: string;
  unitNumber: string;
  truckType: EquipmentType;
  make?: string;
  model?: string;
  year?: number;
  vin?: string;
  plate?: string;
  notes?: string;
  active: boolean;
}

export interface CarrierTrailer {
  id: string;
  unitNumber: string;
  trailerType: EquipmentType;
  vin?: string;
  plate?: string;
  notes?: string;
  active: boolean;
}

export interface CarrierFactoringInfo {
  usesFactoring: boolean;
  factoringCompany?: string;
  remitToAddress?: string;
  factoringContact?: string;
  paymentInstructions?: string;
  noaStatus?: string;
  noaDocumentId?: string;
}

export interface Carrier {
  id: string;
  legalName: string;
  dba?: string;
  mcNumber: string;
  dotNumber: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  primaryContactName: string;
  primaryContactPhone: string;
  primaryContactEmail: string;
  status: CarrierStatus;
  assignmentEligible: boolean;
  // Nullable on the backend (`Json?`) — genuinely `null` until
  // CarrierEligibilityService.recalculate() first runs (triggered by an
  // insurance/FMCSA/document event, not by carrier creation itself), so
  // a freshly-created carrier has `null` here, not `[]`.
  ineligibilityReasons: string[] | null;
  // Only present when status === 'PENDING' -- the narrower activation-
  // readiness check (the 6 compliance conditions only, no status check,
  // since a Pending carrier's status can never itself be Active yet).
  // This is the correct signal for the Activate button; assignmentEligible
  // above is structurally always false pre-activation and is not it.
  activationReady?: boolean;
  activationReasons?: string[];
  createdAt: string;
  contacts?: CarrierContact[];
  insuranceRecords?: CarrierInsuranceRecord[];
  fmcsaVerifications?: CarrierFmcsaVerification[];
  serviceAreas?: CarrierServiceArea[];
  factoringInfo?: CarrierFactoringInfo | null;
  drivers?: CarrierDriver[];
  trucks?: CarrierTruck[];
  trailers?: CarrierTrailer[];
}

export interface CarrierListFilters {
  status?: CarrierStatus;
  assignmentEligible?: boolean;
}

export interface CreateCarrierRequest {
  legalName: string;
  dba?: string;
  mcNumber: string;
  dotNumber: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  primaryContactName: string;
  primaryContactPhone: string;
  primaryContactEmail: string;
}

export type UpdateCarrierRequest = Partial<Omit<CreateCarrierRequest, 'mcNumber' | 'dotNumber'>>;

/**
 * `POST /carriers`'s 409 CONFLICT shape — a hard block, unlike the
 * customer module's soft duplicate warning: no `reasonCode`, no
 * override flag, just a link to the existing record.
 */
export interface CarrierDuplicateConflictDetails {
  existingCarrierId: string;
}

export interface AddCarrierContactRequest {
  name: string;
  email?: string;
  phone?: string;
  role: CarrierContactRole;
  isPrimary?: boolean;
}

export interface AddCarrierInsuranceRequest {
  coverageType: InsuranceCoverageType;
  coverageAmount: string;
  insuranceCompany: string;
  agentContact?: string;
  effectiveDate: string;
  expirationDate: string;
  coiDocumentId: string;
}

export interface AddFmcsaVerificationRequest {
  verificationDate: string;
  resultStatus: string;
  authorityInfo?: string;
  notes?: string;
}

export interface AddServiceAreaRequest {
  type: CarrierServiceAreaType;
  originCity?: string;
  originState?: string;
  destinationCity?: string;
  destinationState?: string;
  regionLabel?: string;
  notes?: string;
}

export interface AddDriverRequest {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  licenseNumber?: string;
  notes?: string;
}

export interface AddTruckRequest {
  unitNumber: string;
  truckType: EquipmentType;
  make?: string;
  model?: string;
  year?: number;
  vin?: string;
  plate?: string;
  notes?: string;
}

export interface AddTrailerRequest {
  unitNumber: string;
  trailerType: EquipmentType;
  vin?: string;
  plate?: string;
  notes?: string;
}

export type UpdateFactoringInfoRequest = CarrierFactoringInfo;

export const carriersApi = {
  list: (filters?: CarrierListFilters) => apiRequest<Carrier[]>('/carriers', { query: filters }),

  getById: (id: string) => apiRequest<Carrier>(`/carriers/${id}`),

  create: (body: CreateCarrierRequest) =>
    apiRequest<Carrier>('/carriers', { method: 'POST', body }),

  update: (id: string, body: UpdateCarrierRequest) =>
    apiRequest<Carrier>(`/carriers/${id}`, { method: 'PATCH', body }),

  addContact: (id: string, body: AddCarrierContactRequest) =>
    apiRequest<CarrierContact>(`/carriers/${id}/contacts`, { method: 'POST', body }),

  addInsurance: (id: string, body: AddCarrierInsuranceRequest) =>
    apiRequest<CarrierInsuranceRecord>(`/carriers/${id}/insurance`, { method: 'POST', body }),

  recordFmcsaVerification: (id: string, body: AddFmcsaVerificationRequest) =>
    apiRequest<CarrierFmcsaVerification>(`/carriers/${id}/fmcsa-verification`, {
      method: 'POST',
      body,
    }),

  activate: (id: string) => apiRequest<Carrier>(`/carriers/${id}/activate`, { method: 'POST' }),

  addServiceArea: (id: string, body: AddServiceAreaRequest) =>
    apiRequest<CarrierServiceArea>(`/carriers/${id}/service-areas`, { method: 'POST', body }),

  addDriver: (id: string, body: AddDriverRequest) =>
    apiRequest<CarrierDriver>(`/carriers/${id}/drivers`, { method: 'POST', body }),

  addTruck: (id: string, body: AddTruckRequest) =>
    apiRequest<CarrierTruck>(`/carriers/${id}/trucks`, { method: 'POST', body }),

  addTrailer: (id: string, body: AddTrailerRequest) =>
    apiRequest<CarrierTrailer>(`/carriers/${id}/trailers`, { method: 'POST', body }),

  upsertFactoring: (id: string, body: UpdateFactoringInfoRequest) =>
    apiRequest<CarrierFactoringInfo>(`/carriers/${id}/factoring`, { method: 'PATCH', body }),
};
