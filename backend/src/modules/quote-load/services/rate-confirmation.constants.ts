import { JobsOptions } from 'bullmq';

export const RATE_CONFIRMATION_QUEUE = 'RATE_CONFIRMATION_QUEUE';
export const RATE_CONFIRMATION_QUEUE_NAME = 'rate-confirmation-pdf';

export interface RateConfirmationJobData {
  documentId: string;
  organizationId: string;
  loadId: string;
}

/** Frontend Phase 16 — same approved retry policy as the malware-scan queue. */
export const RATE_CONFIRMATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};
