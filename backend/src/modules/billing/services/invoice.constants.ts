import { JobsOptions } from 'bullmq';

export const INVOICE_QUEUE = 'INVOICE_QUEUE';
export const INVOICE_QUEUE_NAME = 'invoice-pdf';

export interface InvoiceJobData {
  documentId: string;
  organizationId: string;
  invoiceId: string;
}

/** Frontend Phase 16 — same approved retry policy as the malware-scan queue. */
export const INVOICE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};
