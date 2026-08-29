import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { SpreadsheetService } from '../../common/spreadsheet/spreadsheet.service';
import { CustomerModule } from '../customer/customer.module';
import { CarrierModule } from '../carrier/carrier.module';
import { ImportController } from './controllers/import.controller';
import { ImportBatchService } from './services/import-batch.service';
import { ImportCommitWorker } from './services/import-commit.worker';
import { ImportAdapterRegistry } from './adapters/import-adapter.registry';
import { ParentResolutionService } from './adapters/parent-resolution';
import { CustomerImportAdapter } from './adapters/customer-import.adapter';
import { CustomerContactImportAdapter } from './adapters/customer-contact-import.adapter';
import { CustomerLocationImportAdapter } from './adapters/customer-location-import.adapter';
import { CarrierImportAdapter } from './adapters/carrier-import.adapter';
import { CarrierContactImportAdapter } from './adapters/carrier-contact-import.adapter';
import { DriverImportAdapter } from './adapters/driver-import.adapter';
import { TruckImportAdapter } from './adapters/truck-import.adapter';
import { TrailerImportAdapter } from './adapters/trailer-import.adapter';
import { IMPORT_COMMIT_QUEUE, IMPORT_COMMIT_QUEUE_NAME } from './import.constants';

/**
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13). Mirrors DocumentModule's
 * Queue-provider wiring exactly (dedicated duplicated-connection provider,
 * explicitly `.quit()`'d in onModuleDestroy). Imports CustomerModule and
 * CarrierModule so the adapters can inject the real, existing
 * CustomerService/CarrierService — never a second implementation of their
 * business rules (approved Decision 1).
 */
const IMPORT_COMMIT_QUEUE_CONNECTION = 'IMPORT_COMMIT_QUEUE_CONNECTION';

@Module({
  imports: [CustomerModule, CarrierModule],
  controllers: [ImportController],
  providers: [
    ImportBatchService,
    ImportCommitWorker,
    ImportAdapterRegistry,
    ParentResolutionService,
    SpreadsheetService,
    CustomerImportAdapter,
    CustomerContactImportAdapter,
    CustomerLocationImportAdapter,
    CarrierImportAdapter,
    CarrierContactImportAdapter,
    DriverImportAdapter,
    TruckImportAdapter,
    TrailerImportAdapter,
    {
      provide: IMPORT_COMMIT_QUEUE_CONNECTION,
      useFactory: (redis: Redis) => redis.duplicate(),
      inject: [REDIS_CLIENT],
    },
    {
      provide: IMPORT_COMMIT_QUEUE,
      useFactory: (connection: Redis) => new Queue(IMPORT_COMMIT_QUEUE_NAME, { connection }),
      inject: [IMPORT_COMMIT_QUEUE_CONNECTION],
    },
  ],
})
export class ImportModule implements OnModuleDestroy {
  constructor(
    @Inject(IMPORT_COMMIT_QUEUE) private readonly commitQueue: Queue,
    @Inject(IMPORT_COMMIT_QUEUE_CONNECTION) private readonly commitQueueConnection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.commitQueue.close();
    await this.commitQueueConnection.quit();
  }
}
