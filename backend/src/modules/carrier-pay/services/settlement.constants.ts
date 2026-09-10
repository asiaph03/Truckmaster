import { JobsOptions } from 'bullmq';

export const SETTLEMENT_QUEUE = 'SETTLEMENT_QUEUE';
export const SETTLEMENT_QUEUE_NAME = 'settlement-pdf';

export interface SettlementJobData {
  documentId: string;
  organizationId: string;
  carrierPaymentId: string;
}

/**
 * Monitoring Phase 4A-6 — retention only; no change to attempts/backoff.
 * Completed: 7 days / 1000 entries. Failed: 30 days / 2000 entries — see
 * MALWARE_SCAN_JOB_OPTIONS for the full reasoning shared by every
 * event-driven queue.
 */
export const SETTLEMENT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 604800 },
  removeOnFail: { count: 2000, age: 2592000 },
};
