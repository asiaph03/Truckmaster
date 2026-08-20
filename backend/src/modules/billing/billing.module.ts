import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { EMAIL_SENDER } from '../../common/email/email-sender.interface';
import { ConsoleEmailSender } from '../../common/email/console-email-sender';
import { PDF_GENERATOR } from '../../common/pdf/pdf-generator.interface';
import { StubPdfGenerator } from '../../common/pdf/stub-pdf-generator';
import { IdentityModule } from '../identity/identity.module';
import { InvoiceController } from './controllers/invoice.controller';
import { ChargeTypeController } from './controllers/charge-type.controller';
import { InvoiceService } from './services/invoice.service';
import { ChargeTypeService } from './services/charge-type.service';
import { InvoiceDocumentGenerationWorker } from './services/invoice-document-generation.worker';
import { INVOICE_QUEUE, INVOICE_QUEUE_NAME } from './services/invoice.constants';

/**
 * Phase 6 — genuinely new module (TECHNICAL_ARCHITECTURE.md §1.2's
 * module-ownership table), unlike Phase 4/5 which purely extended
 * QuoteLoadModule. EMAIL_SENDER/PDF_GENERATOR are registered locally here
 * too (mirroring QuoteLoadModule's own local registration) rather than
 * shared across modules — no cross-module DI wiring exists for these
 * tokens today, and introducing one is out of Phase 6's approved scope.
 */
const INVOICE_QUEUE_CONNECTION = 'INVOICE_QUEUE_CONNECTION';

@Module({
  imports: [IdentityModule],
  controllers: [InvoiceController, ChargeTypeController],
  providers: [
    InvoiceService,
    ChargeTypeService,
    InvoiceDocumentGenerationWorker,
    { provide: EMAIL_SENDER, useClass: ConsoleEmailSender },
    { provide: PDF_GENERATOR, useClass: StubPdfGenerator },
    {
      provide: INVOICE_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: INVOICE_QUEUE,
      useFactory: (connection: Redis) => new Queue(INVOICE_QUEUE_NAME, { connection }),
      inject: [INVOICE_QUEUE_CONNECTION],
    },
  ],
})
export class BillingModule implements OnModuleDestroy {
  constructor(
    @Inject(INVOICE_QUEUE) private readonly invoiceQueue: Queue,
    @Inject(INVOICE_QUEUE_CONNECTION) private readonly invoiceConnection: Redis,
  ) {}

  /** Mirrors QuoteLoadModule/DocumentModule's onModuleDestroy exactly — see their comments for why this is required. */
  async onModuleDestroy(): Promise<void> {
    await this.invoiceQueue.close();
    await this.invoiceConnection.quit();
  }
}
