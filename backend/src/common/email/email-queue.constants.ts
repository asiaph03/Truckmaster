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
export interface EmailJobData {
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

/** Frontend Phase 16 — same approved retry policy as the other two background integrations. */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};
