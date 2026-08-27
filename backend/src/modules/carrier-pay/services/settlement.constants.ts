import { JobsOptions } from 'bullmq';

export const SETTLEMENT_QUEUE = 'SETTLEMENT_QUEUE';
export const SETTLEMENT_QUEUE_NAME = 'settlement-pdf';

export interface SettlementJobData {
  documentId: string;
  organizationId: string;
  carrierPaymentId: string;
}

/** Frontend Phase 16 — same approved retry policy as the malware-scan queue. */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};
