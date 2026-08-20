import { Module } from '@nestjs/common';
import { ReportingController } from './controllers/reporting.controller';
import { ReportingService } from './services/reporting.service';

/**
 * Phase 8 (Reporting Foundation) — TECHNICAL_ARCHITECTURE.md §1.2's
 * Reporting module: "read-only, cross-module queries," owns no tables.
 * No other module imports are needed — every query goes through
 * `PrismaService` directly, per §1.2's explicit exception for this module.
 */
@Module({
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}
