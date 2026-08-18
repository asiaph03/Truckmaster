export const RATE_CONFIRMATION_QUEUE = 'RATE_CONFIRMATION_QUEUE';
export const RATE_CONFIRMATION_QUEUE_NAME = 'rate-confirmation-pdf';

export interface RateConfirmationJobData {
  documentId: string;
  organizationId: string;
  loadId: string;
}
