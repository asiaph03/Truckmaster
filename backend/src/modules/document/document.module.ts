import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { MALWARE_SCANNER } from '../../common/malware-scan/malware-scanner.interface';
import { StubMalwareScanner } from '../../common/malware-scan/stub-malware-scanner';
import { CarrierModule } from '../carrier/carrier.module';
import { DocumentController } from './controllers/document.controller';
import { CarrierDocumentsController } from './controllers/carrier-documents.controller';
import { DocumentService } from './services/document.service';
import { MalwareScanWorker } from './services/malware-scan.worker';
import { MALWARE_SCAN_QUEUE, MALWARE_SCAN_QUEUE_NAME } from './services/malware-scan.constants';

@Module({
  imports: [CarrierModule],
  controllers: [DocumentController, CarrierDocumentsController],
  providers: [
    DocumentService,
    MalwareScanWorker,
    { provide: MALWARE_SCANNER, useClass: StubMalwareScanner },
    {
      provide: MALWARE_SCAN_QUEUE,
      useFactory: (redis: Redis) =>
        new Queue(MALWARE_SCAN_QUEUE_NAME, { connection: redis.duplicate() }),
      inject: [REDIS_CLIENT],
    },
  ],
  exports: [DocumentService],
})
export class DocumentModule implements OnModuleDestroy {
  constructor(@Inject(MALWARE_SCAN_QUEUE) private readonly scanQueue: Queue) {}

  async onModuleDestroy(): Promise<void> {
    await this.scanQueue.close();
  }
}
