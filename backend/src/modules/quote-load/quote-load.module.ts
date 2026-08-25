import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { EMAIL_SENDER } from '../../common/email/email-sender.interface';
import { ConsoleEmailSender } from '../../common/email/console-email-sender';
import { PDF_GENERATOR } from '../../common/pdf/pdf-generator.interface';
import { StubPdfGenerator } from '../../common/pdf/stub-pdf-generator';
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
 * EMAIL_SENDER/PDF_GENERATOR are registered locally here rather than
 * exported from IdentityModule/elsewhere, keeping this module
 * self-contained and Phase 1-3 modules untouched.
 *
 * Phase 5 (POD Receipt & Documentation) adds `LoadPodStatusService`,
 * exported so DocumentModule can inject it (mirroring how DocumentService
 * already injects CarrierEligibilityService from CarrierModule for the
 * exact same "recalculate a derived milestone after a document event"
 * pattern) — no schema/RLS change, purely an additive service export.
 */
const RATE_CONFIRMATION_QUEUE_CONNECTION = 'RATE_CONFIRMATION_QUEUE_CONNECTION';

@Module({
  imports: [IdentityModule, CarrierModule],
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
    { provide: EMAIL_SENDER, useClass: ConsoleEmailSender },
    { provide: PDF_GENERATOR, useClass: StubPdfGenerator },
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
