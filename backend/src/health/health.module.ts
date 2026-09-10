import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { WorkerHealthController } from './worker-health.controller';

@Module({
  controllers: [HealthController, WorkerHealthController],
})
export class HealthModule {}
