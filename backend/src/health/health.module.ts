import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkerHealthController } from './worker-health.controller';
import { QueueHealthController } from './queue-health.controller';
import { SweepHealthController } from './sweep-health.controller';

@Module({
  controllers: [HealthController, WorkerHealthController, QueueHealthController, SweepHealthController],
})
export class HealthModule {}
