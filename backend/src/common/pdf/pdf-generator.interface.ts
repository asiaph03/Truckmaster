/**
 * Replaceable PDF-generation provider (Phase 4, mirroring the
 * IMalwareScanner/IEmailSender pattern — Architecture Decision 10 / the
 * §1.3 R1 email precedent). TECHNICAL_ARCHITECTURE.md §14 explicitly
 * defers the PDF library choice to a later deployment decision ("🟡
 * deferred to Stage 7"); this interface is the locked deliverable for now,
 * the concrete renderer (e.g. pdf-lib, Puppeteer, a hosted PDF API) is a
 * deployment-time choice that never touches CarrierSourcingService or the
 * queue/worker around it.
 *
 * Scoped narrowly to Rate Confirmation generation (the only PDF need in
 * Phase 4) rather than a generic multi-document-type interface — no other
 * PDF use case exists yet to design around.
 */
export interface RateConfirmationPdfInput {
  loadNumber: string;
  carrierLegalName: string;
  carrierRate: string;
  customerLegalName: string;
  equipmentType: string;
  stops: { sequence: number; stopType: string; city: string; state: string }[];
}

export interface IPdfGenerator {
  generateRateConfirmation(input: RateConfirmationPdfInput): Promise<Buffer>;
}

export const PDF_GENERATOR = 'PDF_GENERATOR';
