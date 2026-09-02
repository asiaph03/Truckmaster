import { JobsOptions } from 'bullmq';

/**
 * Rate Confirmation → New Load auto-populate feature. Mirrors
 * malware-scan.constants.ts's exact shape — a plain queue-name string
 * constant (not a NestJS DI token), so the Queue producer (owned by
 * DocumentModule, which enqueues from DocumentService.applyScanResult
 * after a CLEAN scan) and the Worker consumer (owned by
 * RateConfirmationExtractionModule, this module) can agree on which
 * BullMQ queue to use without either module needing to import the other
 * — avoids a circular module dependency (DocumentModule already imports
 * QuoteLoadModule; this module imports DocumentModule for DocumentService,
 * so DocumentModule must never import this module back).
 */
export const RATE_CONFIRMATION_EXTRACTION_QUEUE = 'RATE_CONFIRMATION_EXTRACTION_QUEUE';
export const RATE_CONFIRMATION_EXTRACTION_QUEUE_NAME = 'rate-confirmation-extraction';

export interface RateConfirmationExtractionJobData {
  extractionId: string;
  documentId: string;
  organizationId: string;
  storageKey: string;
}

/**
 * Same shape as MALWARE_SCAN_JOB_OPTIONS (3 attempts, exponential
 * backoff). Extraction is local/synchronous (no external network call),
 * so most failures are deterministic (e.g. no text layer) and retrying
 * won't change the outcome — but this still guards against a transient
 * local resource issue (e.g. a momentary Redis hiccup while writing job
 * state) without needing a second, different job-options shape.
 */
export const RATE_CONFIRMATION_EXTRACTION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

/**
 * Extraction job state lives in Redis, not Postgres (approved design
 * decision — this data is transient scratch state for one New Load form
 * session, never queried after the fact, and reuses infrastructure
 * that's already fully tenant-isolation-hardened via job payloads
 * carrying organizationId). 1 hour comfortably covers "upload, wait for
 * extraction, review, fix a few fields, submit" without accumulating
 * indefinitely.
 */
export const EXTRACTION_JOB_REDIS_TTL_SECONDS = 60 * 60;

export function extractionJobRedisKey(organizationId: string, extractionId: string): string {
  return `rate-confirmation-extraction:${organizationId}:${extractionId}`;
}
