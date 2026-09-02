import type { EquipmentType } from '@tms/shared-constants';
import { apiRequest } from './client';

/**
 * Rate Confirmation → New Load auto-populate feature — mirrors the
 * backend's ExtractedRateConfirmationData/ExtractedStop schema field-for-
 * field (see backend/src/modules/rate-confirmation-extraction/rate-
 * confirmation-extractor.interface.ts). ONE ordered `stops` array, never
 * split pickup/delivery arrays — preserves document order exactly.
 */
export interface ExtractedStop {
  stopType: 'PICKUP' | 'DELIVERY';
  companyName: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
  appointmentDatetime: string | null;
}

/** Mirrors CreateCustomerRequest's field set exactly — used only to prefill the existing Customer-creation modal when no match is found; never sent anywhere as-is. */
export interface ExtractedCustomer {
  extractedName: string;
  billingAddressLine1: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
}

export interface ExtractedRateConfirmationData {
  customer: ExtractedCustomer | null;
  equipmentType: EquipmentType | null;
  customerRate: string | null;
  customerPoNumber: string | null;
  bolNumber: string | null;
  pickupNumber: string | null;
  customerReferenceNumber: string | null;
  stops: ExtractedStop[];
  warnings: string[];
  unmappedFields: { label: string; value: string }[];
}

export type RateConfirmationScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED';
export type RateConfirmationExtractionStatus = 'NOT_STARTED' | 'PENDING' | 'COMPLETE' | 'FAILED';

export interface InitiateRateConfirmationExtractionRequest {
  fileName: string;
  mimeType: 'application/pdf';
  fileSizeBytes: number;
}

export interface RateConfirmationExtractionStatusResponse {
  extractionId: string;
  scanStatus: RateConfirmationScanStatus;
  extractionStatus: RateConfirmationExtractionStatus;
  extractionError: string | null;
  data: ExtractedRateConfirmationData | null;
}

export const rateConfirmationExtractionApi = {
  initiate: (body: InitiateRateConfirmationExtractionRequest) =>
    apiRequest<{ extractionId: string; uploadUrl: string }>('/rate-confirmation-extractions', {
      method: 'POST',
      body,
    }),

  confirm: (extractionId: string) =>
    apiRequest<{ extractionId: string; scanStatus: 'PENDING' }>(
      `/rate-confirmation-extractions/${extractionId}/confirm`,
      { method: 'POST' },
    ),

  getStatus: (extractionId: string) =>
    apiRequest<RateConfirmationExtractionStatusResponse>(
      `/rate-confirmation-extractions/${extractionId}`,
    ),

  retry: (extractionId: string) =>
    apiRequest<{ extractionId: string; extractionStatus: 'PENDING' }>(
      `/rate-confirmation-extractions/${extractionId}/retry`,
      { method: 'POST' },
    ),

  /**
   * `PUT`s the raw file bytes directly to the presigned upload URL —
   * mirrors `documentsApi.putFileToUploadUrl`'s exact approach (different
   * origin, no session cookie/JSON envelope involved).
   */
  putFileToUploadUrl: async (uploadUrl: string, file: File): Promise<void> => {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!response.ok) {
      throw new Error(`Upload failed with status ${response.status}.`);
    }
  },
};
