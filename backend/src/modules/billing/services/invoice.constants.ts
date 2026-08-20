export const INVOICE_QUEUE = 'INVOICE_QUEUE';
export const INVOICE_QUEUE_NAME = 'invoice-pdf';

export interface InvoiceJobData {
  documentId: string;
  organizationId: string;
  invoiceId: string;
}
