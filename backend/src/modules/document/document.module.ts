import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { MALWARE_SCANNER } from '../../common/malware-scan/malware-scanner.interface';
import { CloudmersiveMalwareScanner } from '../../common/malware-scan/cloudmersive-malware-scanner';
import { CarrierModule } from '../carrier/carrier.module';
import { QuoteLoadModule } from '../quote-load/quote-load.module';
import { DocumentController } from './controllers/document.controller';
import { CarrierDocumentsController } from './controllers/carrier-documents.controller';
import { PodDocumentsController } from './controllers/pod-documents.controller';
import { PopDocumentsController } from './controllers/pop-documents.controller';
import { DocumentTypeController } from './controllers/document-type.controller';
import { DocumentService } from './services/document.service';
import { DocumentSearchService } from './services/document-search.service';
import { DocumentTypeService } from './services/document-type.service';
import { MalwareScanWorker } from './services/malware-scan.worker';
import { MALWARE_SCAN_QUEUE, MALWARE_SCAN_QUEUE_NAME } from './services/malware-scan.constants';

/**
 * Internal token for the Queue producer's own duplicated Redis connection
 * — kept as a separate provider (rather than inlined into the
 * MALWARE_SCAN_QUEUE factory below) purely so DocumentModule's
 * onModuleDestroy can inject and explicitly `.quit()` it. BullMQ does not
 * close an externally-supplied ioredis instance on `queue.close()`.
 */
const MALWARE_SCAN_QUEUE_CONNECTION = 'MALWARE_SCAN_QUEUE_CONNECTION';

@Module({
  imports: [CarrierModule, QuoteLoadModule],
  controllers: [
    DocumentController,
    CarrierDocumentsController,
    PodDocumentsController,
    PopDocumentsController,
    DocumentTypeController,
  ],
  providers: [
    DocumentService,
    DocumentSearchService,
    DocumentTypeService,
    MalwareScanWorker,
    { provide: MALWARE_SCANNER, useClass: CloudmersiveMalwareScanner },
    {
      provide: MALWARE_SCAN_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: MALWARE_SCAN_QUEUE,
      useFactory: (connection: Redis) => new Queue(MALWARE_SCAN_QUEUE_NAME, { connection }),
      inject: [MALWARE_SCAN_QUEUE_CONNECTION],
    },
  ],
  exports: [DocumentService],
})
export class DocumentModule implements OnModuleDestroy {
  constructor(
    @Inject(MALWARE_SCAN_QUEUE) private readonly scanQueue: Queue,
    @Inject(MALWARE_SCAN_QUEUE_CONNECTION) private readonly scanQueueConnection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.scanQueue.close();
    await this.scanQueueConnection.quit();
  }
}
