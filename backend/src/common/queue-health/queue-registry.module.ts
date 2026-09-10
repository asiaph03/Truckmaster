import { Global, Module } from '@nestjs/common';
import { QueueRegistryService } from './queue-registry.service';

/**
 * Monitoring Phase 4A-6 — global, like WorkerHealthModule (Phase 4A-3), so
 * every queue-producing module can inject QueueRegistryService without each
 * owning module needing its own import wiring.
 */
@Global()
@Module({
  providers: [QueueRegistryService],
  exports: [QueueRegistryService],
})
export class QueueRegistryModule {}
