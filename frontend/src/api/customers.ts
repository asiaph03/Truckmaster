import type {
  CustomerContactRole,
  CustomerLocationType,
  EquipmentType,
  PaymentTerms,
} from '@tms/shared-constants';
import { apiRequest } from './client';

export type CustomerStatus = 'PROSPECT' | 'ACTIVE' | 'INACTIVE' | 'BLOCKED';

export interface CustomerContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  role: CustomerContactRole;
  isPrimary: boolean;
}

export interface CustomerLocation {
  id: string;
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  locationType: CustomerLocationType;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  operatingHours?: string;
  appointmentRequirements?: string;
  notes?: string;
}

export interface CustomerRateAgreement {
  id: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  equipmentType: EquipmentType;
  rate: string;
  rateType: string;
  effectiveDate: string;
  expirationDate?: string;
  fuelSurchargeRules?: string;
  notes?: string;
}

export interface Customer {
  id: string;
  legalName: string;
  billingAddressLine1: string;
  billingCity: string;
  billingState: string;
  billingZip: string;
  billingCountry: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  accountOwnerUserId?: string;
  paymentTerms: PaymentTerms;
  paymentTermsSource: 'INHERITED' | 'OVERRIDE';
  status: CustomerStatus;
  createdByUserId: string;
  createdAt: string;
  contacts?: CustomerContact[];
  locations?: CustomerLocation[];
  rateAgreements?: CustomerRateAgreement[];
}

export interface CustomerListFilters {
  status?: CustomerStatus;
  search?: string;
}

export interface CreateCustomerRequest {
  legalName: string;
  billingAddressLine1: string;
  billingCity: string;
  billingState: string;
  billingZip: string;
  billingCountry?: string;
  primaryContactName: string;
  primaryContactEmail: string;
  primaryContactPhone: string;
  accountOwnerUserId?: string;
  paymentTermsOverride?: PaymentTerms;
  acknowledgeDuplicates?: boolean;
}

export type UpdateCustomerRequest = Partial<
  Omit<CreateCustomerRequest, 'acknowledgeDuplicates'>
> & {
  paymentTerms?: PaymentTerms;
};

export interface ChangeCustomerStatusRequest {
  status: CustomerStatus;
}

export interface AddCustomerContactRequest {
  name: string;
  email?: string;
  phone?: string;
  role: CustomerContactRole;
  isPrimary?: boolean;
}

export interface AddCustomerLocationRequest {
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  locationType: CustomerLocationType;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  operatingHours?: string;
  appointmentRequirements?: string;
  notes?: string;
}

export interface AddCustomerRateAgreementRequest {
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  equipmentType: EquipmentType;
  rate: string;
  rateType: string;
  effectiveDate: string;
  expirationDate?: string;
  fuelSurchargeRules?: string;
  notes?: string;
}

/**
 * `POST /customers`'s 409 CONFLICT shape when `acknowledgeDuplicates`
 * wasn't set — the "View Existing / Continue Anyway / Cancel" warning
 * modal keys off `details.matches` (Workflow 2 §2.2). Distinct from the
 * carrier module's hard-block 409 (see carriers.ts), which has no
 * `reasonCode`/`matches` and no override flag.
 */
export interface CustomerDuplicateConflictDetails {
  reasonCode: 'POSSIBLE_DUPLICATE_CUSTOMER';
  matches: { customerId: string; legalName: string; matchedOn: string[] }[];
}

export const customersApi = {
  list: (filters?: CustomerListFilters) => apiRequest<Customer[]>('/customers', { query: filters }),

  getById: (id: string) => apiRequest<Customer>(`/customers/${id}`),

  create: (body: CreateCustomerRequest) =>
    apiRequest<Customer>('/customers', { method: 'POST', body }),

  update: (id: string, body: UpdateCustomerRequest) =>
    apiRequest<Customer>(`/customers/${id}`, { method: 'PATCH', body }),

  setStatus: (id: string, body: ChangeCustomerStatusRequest) =>
    apiRequest<Customer>(`/customers/${id}/status`, { method: 'POST', body }),

  addContact: (id: string, body: AddCustomerContactRequest) =>
    apiRequest<CustomerContact>(`/customers/${id}/contacts`, { method: 'POST', body }),

  addLocation: (id: string, body: AddCustomerLocationRequest) =>
    apiRequest<CustomerLocation>(`/customers/${id}/locations`, { method: 'POST', body }),

  addRateAgreement: (id: string, body: AddCustomerRateAgreementRequest) =>
    apiRequest<CustomerRateAgreement>(`/customers/${id}/rate-agreements`, {
      method: 'POST',
      body,
    }),
};
