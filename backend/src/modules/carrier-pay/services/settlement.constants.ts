export const SETTLEMENT_QUEUE = 'SETTLEMENT_QUEUE';
export const SETTLEMENT_QUEUE_NAME = 'settlement-pdf';

export interface SettlementJobData {
  documentId: string;
  organizationId: string;
  carrierPaymentId: string;
}
