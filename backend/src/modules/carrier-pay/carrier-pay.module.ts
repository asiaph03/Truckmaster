import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { PDF_GENERATOR } from '../../common/pdf/pdf-generator.interface';
import { PdfkitPdfGenerator } from '../../common/pdf/pdfkit-pdf-generator';
import { IdentityModule } from '../identity/identity.module';
import { CarrierPaymentController } from './controllers/carrier-payment.controller';
import { CarrierPaymentService } from './services/carrier-payment.service';
import { SettlementDocumentGenerationWorker } from './services/settlement-document-generation.worker';
import { SETTLEMENT_QUEUE, SETTLEMENT_QUEUE_NAME } from './services/settlement.constants';

/** Phase 6 — genuinely new module, per the locked module-boundary decision (distinct from BillingModule). */
const SETTLEMENT_QUEUE_CONNECTION = 'SETTLEMENT_QUEUE_CONNECTION';

@Module({
  imports: [IdentityModule],
  controllers: [CarrierPaymentController],
  providers: [
    CarrierPaymentService,
    SettlementDocumentGenerationWorker,
    { provide: PDF_GENERATOR, useClass: PdfkitPdfGenerator },
    {
      provide: SETTLEMENT_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: SETTLEMENT_QUEUE,
      useFactory: (connection: Redis) => new Queue(SETTLEMENT_QUEUE_NAME, { connection }),
      inject: [SETTLEMENT_QUEUE_CONNECTION],
    },
  ],
})
export class CarrierPayModule implements OnModuleDestroy {
  constructor(
    @Inject(SETTLEMENT_QUEUE) private readonly settlementQueue: Queue,
    @Inject(SETTLEMENT_QUEUE_CONNECTION) private readonly settlementConnection: Redis,
  ) {}

  /** Mirrors QuoteLoadModule/BillingModule's onModuleDestroy exactly. */
  async onModuleDestroy(): Promise<void> {
    await this.settlementQueue.close();
    await this.settlementConnection.quit();
  }
}
