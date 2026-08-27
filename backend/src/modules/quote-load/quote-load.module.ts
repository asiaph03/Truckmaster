import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { EmailModule } from '../../common/email/email.module';
import { PDF_GENERATOR } from '../../common/pdf/pdf-generator.interface';
import { PdfkitPdfGenerator } from '../../common/pdf/pdfkit-pdf-generator';
import { IdentityModule } from '../identity/identity.module';
import { CarrierModule } from '../carrier/carrier.module';
import { QuoteController } from './controllers/quote.controller';
import { LoadController } from './controllers/load.controller';
import { QuoteService } from './services/quote.service';
import { LoadService } from './services/load.service';
import { RateAgreementMatchingService } from './services/rate-agreement-matching.service';
import { CarrierSourcingService } from './services/carrier-sourcing.service';
import { DispatchTrackingService } from './services/dispatch-tracking.service';
import { LoadStatusDerivationService } from './services/load-status-derivation.service';
import { LoadPodStatusService } from './services/load-pod-status.service';
import { ActivityHistoryService } from './services/activity-history.service';
import { LoadSearchService } from './services/load-search.service';
import { RateConfirmationGenerationWorker } from './services/rate-confirmation-generation.worker';
import {
  RATE_CONFIRMATION_QUEUE,
  RATE_CONFIRMATION_QUEUE_NAME,
} from './services/rate-confirmation.constants';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 groups Quote and Load as one "Quote/Load"
 * module — kept as one NestJS module here too, mirroring the IdentityModule
 * precedent for small, tightly-coupled entities (Quote conversion directly
 * creates a Load in the same transaction, same relationship as
 * Organization creation directly creating the initial Membership in
 * Phase 1).
 *
 * Phase 4 (Sourcing & Dispatch) extends this same module rather than
 * introducing a new one (approved plan §5) — CarrierModule is imported for
 * CarrierEligibilityService's live re-check (reused, never duplicated).
 * PDF_GENERATOR is registered locally here. EMAIL_SENDER is not — Frontend
 * Phase 16 consolidated every EMAIL_SENDER registration into the single
 * shared EmailModule (imported below); this module's services inject
 * EMAIL_QUEUE from it instead of calling a provider directly.
 *
 * Phase 5 (POD Receipt & Documentation) adds `LoadPodStatusService`,
 * exported so DocumentModule can inject it (mirroring how DocumentService
 * already injects CarrierEligibilityService from CarrierModule for the
 * exact same "recalculate a derived milestone after a document event"
 * pattern) — no schema/RLS change, purely an additive service export.
 */
const RATE_CONFIRMATION_QUEUE_CONNECTION = 'RATE_CONFIRMATION_QUEUE_CONNECTION';

@Module({
  imports: [IdentityModule, CarrierModule, EmailModule],
  controllers: [QuoteController, LoadController],
  providers: [
    QuoteService,
    LoadService,
    RateAgreementMatchingService,
    CarrierSourcingService,
    DispatchTrackingService,
    LoadStatusDerivationService,
    LoadPodStatusService,
    ActivityHistoryService,
    LoadSearchService,
    RateConfirmationGenerationWorker,
    { provide: PDF_GENERATOR, useClass: PdfkitPdfGenerator },
    {
      provide: RATE_CONFIRMATION_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: RATE_CONFIRMATION_QUEUE,
      useFactory: (connection: Redis) => new Queue(RATE_CONFIRMATION_QUEUE_NAME, { connection }),
      inject: [RATE_CONFIRMATION_QUEUE_CONNECTION],
    },
  ],
  exports: [LoadPodStatusService],
})
export class QuoteLoadModule implements OnModuleDestroy {
  constructor(
    @Inject(RATE_CONFIRMATION_QUEUE) private readonly rateConfirmationQueue: Queue,
    @Inject(RATE_CONFIRMATION_QUEUE_CONNECTION) private readonly rateConfirmationConnection: Redis,
  ) {}

  /**
   * Mirrors DocumentModule's onModuleDestroy exactly — BullMQ does not
   * close an externally-supplied ioredis instance on `queue.close()`, so
   * this duplicated connection must be explicitly `.quit()`'d or it
   * becomes an open handle keeping a Jest e2e run's process alive after
   * the test run itself has finished (the bug fixed at the close of
   * Phase 3 for the malware-scan queue).
   */
  async onModuleDestroy(): Promise<void> {
    await this.rateConfirmationQueue.close();
    await this.rateConfirmationConnection.quit();
  }
}
