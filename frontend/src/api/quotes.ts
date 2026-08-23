import type { EquipmentType } from '@tms/shared-constants';
import { apiRequest } from './client';
import type { BookingSource, RateSource, StopType } from './loads';

export type QuoteStatus = 'OPEN' | 'WON' | 'LOST';
export type QuoteStopType = Extract<StopType, 'PICKUP' | 'DELIVERY'>;

export interface QuoteStop {
  sequence: number;
  stopType: QuoteStopType;
  addressCity: string;
  addressState: string;
  addressZip: string;
  appointmentNotes?: string;
}

export interface Quote {
  id: string;
  customerId: string;
  stops: QuoteStop[];
  equipmentType: EquipmentType;
  // Nullable when redacted server-side for the acting role — never
  // render as $0.00 (same shapeFinancialFields rule as Load).
  customerRate: string | null;
  rateSource: RateSource | null;
  rateAgreementId: string | null;
  expirationDate: string;
  status: QuoteStatus;
  lossReason?: string;
  resultingLoadId?: string;
  createdByUserId: string;
  createdAt: string;
}

export interface QuoteListFilters {
  status?: QuoteStatus;
  customerId?: string;
}

export interface QuoteStopInput {
  sequence: number;
  stopType: QuoteStopType;
  addressCity: string;
  addressState: string;
  addressZip: string;
  appointmentNotes?: string;
}

export interface CreateQuoteRequest {
  customerId: string;
  stops: QuoteStopInput[];
  equipmentType: EquipmentType;
  customerRate: string;
  expirationDate?: string;
}

export interface MarkQuoteLostRequest {
  reason: string;
}

/**
 * Workflow 4 §4.7's mandatory rate re-confirmation step —
 * `confirmedCustomerRate` is always required on convert, even when
 * unchanged from the quoted rate. `Quote.customerRate` itself is never
 * modified server-side; the confirmed value becomes the new Load's rate.
 */
export interface ConvertQuoteRequest {
  confirmedCustomerRate: string;
  confirmInactiveCustomerOverride?: boolean;
}

export const quotesApi = {
  list: (filters?: QuoteListFilters) => apiRequest<Quote[]>('/quotes', { query: filters }),

  getById: (id: string) => apiRequest<Quote>(`/quotes/${id}`),

  create: (body: CreateQuoteRequest) => apiRequest<Quote>('/quotes', { method: 'POST', body }),

  markLost: (id: string, body: MarkQuoteLostRequest) =>
    apiRequest<Quote>(`/quotes/${id}/mark-lost`, { method: 'POST', body }),

  // Returns the newly-created Load (bookingSource: 'QUOTE').
  convert: (id: string, body: ConvertQuoteRequest) =>
    apiRequest<{ id: string; loadNumber: string; bookingSource: BookingSource }>(
      `/quotes/${id}/convert`,
      { method: 'POST', body },
    ),
};
