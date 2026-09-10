import { JobsOptions } from 'bullmq';

export const RATE_CONFIRMATION_QUEUE = 'RATE_CONFIRMATION_QUEUE';
export const RATE_CONFIRMATION_QUEUE_NAME = 'rate-confirmation-pdf';

export interface RateConfirmationJobData {
  documentId: string;
  organizationId: string;
  loadId: string;
}

/**
 * Monitoring Phase 4A-6 — retention only; no change to attempts/backoff.
 * Completed: 7 days / 1000 entries. Failed: 30 days / 2000 entries — see
 * MALWARE_SCAN_JOB_OPTIONS for the full reasoning shared by every
 * event-driven queue.
 */
export const RATE_CONFIRMATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 604800 },
  removeOnFail: { count: 2000, age: 2592000 },
};
