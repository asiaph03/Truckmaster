import { Global, Module } from '@nestjs/common';
import { SweepHealthService } from './sweep-health.service';

/**
 * Monitoring Phase 4A-23D — global, like WorkerHealthModule (Phase 4A-3)
 * and QueueRegistryModule (Phase 4A-6), so ScheduledJobsWorker can write
 * and the new health controller can read without either module needing
 * its own import wiring.
 */
@Global()
@Module({
  providers: [SweepHealthService],
  exports: [SweepHealthService],
})
export class SweepHealthModule {}
