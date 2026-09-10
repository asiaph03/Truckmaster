import { Global, Module } from '@nestjs/common';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * Monitoring Phase 4A-3 — global, like RedisModule, so every worker across
 * every feature module can inject WorkerHeartbeatService without each
 * owning module needing its own import wiring.
 */
@Global()
@Module({
  providers: [WorkerHeartbeatService],
  exports: [WorkerHeartbeatService],
})
export class WorkerHealthModule {}
