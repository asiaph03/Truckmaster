import { Module } from '@nestjs/common';
import { NotificationController } from './controllers/notification.controller';
import { NotificationService } from './services/notification.service';

/**
 * Phase 7 — new module (TECHNICAL_ARCHITECTURE.md §1.2). Exports
 * NotificationService so BackgroundJobsModule can inject it directly
 * (Decision 6 — direct service calls, no event bus).
 */
@Module({
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
