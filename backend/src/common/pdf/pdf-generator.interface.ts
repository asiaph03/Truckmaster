/**
 * Replaceable PDF-generation provider (Phase 4, mirroring the
 * IMalwareScanner/IEmailSender pattern — Architecture Decision 10 / the
 * §1.3 R1 email precedent). Frontend Phase 16 — PDFKit (`PdfkitPdfGenerator`,
 * an in-process library, not a hosted API) is wired behind this interface
 * in the billing, carrier-pay, and quote-load modules; the interface
 * itself never changed, so no call site or the queue/worker around it was
 * touched by that swap.
 *
 * Phase 6 broadens this from its original Phase-4 Rate-Confirmation-only
 * scope to the three document kinds Phase 6 actually needs (Invoice,
 * Settlement) — one shared abstraction, not a second incompatible
 * generator interface, per the approved Phase 6 decision. Still scoped
 * exactly to what's needed today, no further abstraction.
 */
export interface RateConfirmationPdfInput {
  loadNumber: string;
  carrierLegalName: string;
  carrierRate: string;
  customerLegalName: string;
  equipmentType: string;
  stops: { sequence: number; stopType: string; city: string; state: string }[];
}

/** Workflow 8 — one PDF per Invoice (individual or consolidated), regenerated fresh on each Send. */
export interface InvoicePdfInput {
  invoiceNumber: string;
  customerLegalName: string;
  status: string;
  total: string;
  remainingBalance: string;
  dueDate?: string;
  lineItems: { description: string; amount: string }[];
}

/** Workflow 9 §9.8 — one PDF per PAID CarrierPayment, never batched per load. */
export interface SettlementPdfInput {
  carrierLegalName: string;
  loadNumber: string;
  paymentAmount: string;
  paymentType: string;
  paymentDate: string;
  method?: string;
  referenceNumber?: string;
}

export interface IPdfGenerator {
  generateRateConfirmation(input: RateConfirmationPdfInput): Promise<Buffer>;
  generateInvoice(input: InvoicePdfInput): Promise<Buffer>;
  generateSettlement(input: SettlementPdfInput): Promise<Buffer>;
}

export const PDF_GENERATOR = 'PDF_GENERATOR';
