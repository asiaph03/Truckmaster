import { Module } from '@nestjs/common';
import { ReportingController } from './controllers/reporting.controller';
import { ReportingService } from './services/reporting.service';
import { ReportCatalogController } from './controllers/report-catalog.controller';
import { ReportCatalogService } from './services/report-catalog.service';

/**
 * Phase 8 (Reporting Foundation) — TECHNICAL_ARCHITECTURE.md §1.2's
 * Reporting module: "read-only, cross-module queries," owns no tables.
 * No other module imports are needed — every query goes through
 * `PrismaService` directly, per §1.2's explicit exception for this module.
 *
 * Phase 21 (Reports Library) adds ReportCatalogController/Service — the
 * 8 new catalog reports plus the role-aware catalog listing — as a
 * second controller/service pair in this same module rather than
 * growing ReportingController/ReportingService unboundedly.
 */
@Module({
  controllers: [ReportingController, ReportCatalogController],
  providers: [ReportingService, ReportCatalogService],
})
export class ReportingModule {}
