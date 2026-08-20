import { Injectable, Logger } from '@nestjs/common';
import {
  IPdfGenerator,
  InvoicePdfInput,
  RateConfirmationPdfInput,
  SettlementPdfInput,
} from './pdf-generator.interface';

/**
 * No real PDF-rendering library is wired yet — TECHNICAL_ARCHITECTURE.md
 * §14 explicitly defers that choice ("No provider selected yet 🟡"),
 * mirroring StubMalwareScanner's precedent. This stub exists so the full
 * surrounding architecture (async job, Document record, storage key,
 * replaceable interface, audit trail) is real and testable now — swap
 * this class for a real renderer before any production deployment;
 * nothing else in the codebase needs to change to do so.
 *
 * Produces deterministic, human-readable placeholder bytes (not a real
 * PDF) — sufficient to exercise storage upload and Document.fileSizeBytes
 * population without a rendering dependency. Same approach for all three
 * document kinds (Phase 6 broadened this class from Rate-Confirmation-only
 * — existing behavior for that method is unchanged).
 */
@Injectable()
export class StubPdfGenerator implements IPdfGenerator {
  private readonly logger = new Logger(StubPdfGenerator.name);

  async generateRateConfirmation(input: RateConfirmationPdfInput): Promise<Buffer> {
    this.logger.warn(
      `StubPdfGenerator: no real PDF renderer configured — generating placeholder bytes for Load ${input.loadNumber}.`,
    );
    const lines = [
      '%PDF-STUB-1.0',
      `Rate Confirmation — Load ${input.loadNumber}`,
      `Carrier: ${input.carrierLegalName}`,
      `Carrier Rate: ${input.carrierRate}`,
      `Customer: ${input.customerLegalName}`,
      `Equipment: ${input.equipmentType}`,
      ...input.stops
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => `Stop ${s.sequence} (${s.stopType}): ${s.city}, ${s.state}`),
    ];
    return Buffer.from(lines.join('\n'), 'utf-8');
  }

  async generateInvoice(input: InvoicePdfInput): Promise<Buffer> {
    this.logger.warn(
      `StubPdfGenerator: no real PDF renderer configured — generating placeholder bytes for Invoice ${input.invoiceNumber}.`,
    );
    const lines = [
      '%PDF-STUB-1.0',
      `Invoice ${input.invoiceNumber} — ${input.status}`,
      `Customer: ${input.customerLegalName}`,
      `Total: ${input.total}`,
      `Remaining Balance: ${input.remainingBalance}`,
      ...(input.dueDate ? [`Due Date: ${input.dueDate}`] : []),
      ...input.lineItems.map((li) => `${li.description}: ${li.amount}`),
    ];
    return Buffer.from(lines.join('\n'), 'utf-8');
  }

  async generateSettlement(input: SettlementPdfInput): Promise<Buffer> {
    this.logger.warn(
      `StubPdfGenerator: no real PDF renderer configured — generating placeholder bytes for a Carrier Settlement (Load ${input.loadNumber}).`,
    );
    const lines = [
      '%PDF-STUB-1.0',
      `Carrier Settlement — Load ${input.loadNumber}`,
      `Carrier: ${input.carrierLegalName}`,
      `Payment Type: ${input.paymentType}`,
      `Amount: ${input.paymentAmount}`,
      `Payment Date: ${input.paymentDate}`,
      ...(input.method ? [`Method: ${input.method}`] : []),
      ...(input.referenceNumber ? [`Reference: ${input.referenceNumber}`] : []),
    ];
    return Buffer.from(lines.join('\n'), 'utf-8');
  }
}
