import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkerHealthController } from './worker-health.controller';
import { QueueHealthController } from './queue-health.controller';

@Module({
  controllers: [HealthController, WorkerHealthController, QueueHealthController],
})
export class HealthModule {}
