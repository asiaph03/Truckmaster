import { Injectable, Logger } from '@nestjs/common';
import { IPdfGenerator, RateConfirmationPdfInput } from './pdf-generator.interface';

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
 * population without a rendering dependency.
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
}
