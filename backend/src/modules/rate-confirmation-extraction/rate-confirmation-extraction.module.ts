import { Module } from '@nestjs/common';
import { DocumentModule } from '../document/document.module';
import { RateConfirmationExtractionController } from './controllers/rate-confirmation-extraction.controller';
import { RateConfirmationExtractionService } from './services/rate-confirmation-extraction.service';
import { RateConfirmationExtractionJobStore } from './services/rate-confirmation-extraction-job-store.service';
import { RateConfirmationExtractionWorker } from './services/rate-confirmation-extraction.worker';
import { PdfTextExtractorService } from './services/pdf-text-extractor.service';
import { AnthropicRateConfirmationExtractor } from './services/anthropic-rate-confirmation-extractor';
import { RATE_CONFIRMATION_EXTRACTOR } from './rate-confirmation-extractor.interface';

/**
 * Rate Confirmation → New Load auto-populate feature. Imports
 * DocumentModule (exported: DocumentService, and the
 * RATE_CONFIRMATION_EXTRACTION_QUEUE producer token it owns — see that
 * module's own comments for why the producer lives there instead of
 * here) rather than the other way around, so DocumentModule never needs
 * to import this module back — avoids a circular dependency, since
 * DocumentModule already imports QuoteLoadModule.
 *
 * Deliberately does NOT import CustomerModule — customer matching for
 * this feature is entirely client-side (approved design §7), so the
 * backend side of this feature has no Customer-module dependency at all.
 */
@Module({
  imports: [DocumentModule],
  controllers: [RateConfirmationExtractionController],
  providers: [
    RateConfirmationExtractionService,
    RateConfirmationExtractionJobStore,
    RateConfirmationExtractionWorker,
    PdfTextExtractorService,
    { provide: RATE_CONFIRMATION_EXTRACTOR, useClass: AnthropicRateConfirmationExtractor },
  ],
})
export class RateConfirmationExtractionModule {}
