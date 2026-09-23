import { JobsOptions } from 'bullmq';

export const EMAIL_QUEUE = 'EMAIL_QUEUE';
export const EMAIL_QUEUE_NAME = 'email-send';

/**
 * Frontend Phase 16 — entityType/entityId are carried through so a
 * terminal failure (after all retries) can be audited against the
 * correct business record, mirroring how RateConfirmationJobData/
 * InvoiceJobData/SettlementJobData each carry their own entity
 * reference for their own worker's audit writes.
 */
export interface OrganizationScopedEmailJobData {
  to: string;
  subject: string;
  body: string;
  organizationId: string;
  entityType: string;
  entityId: string;
  /**
   * Driver Dispatch Email feature — a safe reference only (never the PDF
   * bytes themselves) so large binary data never goes into Redis.
   * EmailSendWorker resolves this Document (organization-scoped) and
   * reads its bytes from StorageService at send time. Optional — absent
   * for every existing email (invitations, carrier Rate Confirmation,
   * etc.), which continue exactly as before.
   */
  attachmentDocumentId?: string;
}

/**
 * Phase 6B — identity-level emails (password reset) have no organization
 * to scope to: the recipient user may belong to zero, one, or several
 * organizations, and the action itself (resetting a forgotten password)
 * precedes any org context. Deliberately excludes
 * organizationId/entityType/entityId/attachmentDocumentId rather than
 * making them optional on the same interface — every existing call site
 * keeps sending its full OrganizationScopedEmailJobData unchanged, and
 * EmailSendWorker discriminates the two branches via
 * `'organizationId' in job.data`.
 */
export interface IdentityScopedEmailJobData {
  to: string;
  subject: string;
  body: string;
}

export type EmailJobData = OrganizationScopedEmailJobData | IdentityScopedEmailJobData;

/**
 * Monitoring Phase 4A-6 — retention only; no change to attempts/backoff.
 * Completed: 7 days / 1000 entries. Failed: 30 days / 2000 entries — see
 * MALWARE_SCAN_JOB_OPTIONS for the full reasoning shared by every
 * event-driven queue.
 */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 1000, age: 604800 },
  removeOnFail: { count: 2000, age: 2592000 },
};
