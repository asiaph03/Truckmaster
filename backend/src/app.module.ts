import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import configuration from './config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { AuditModule } from './common/audit/audit.module';
import { RequestContextMiddleware } from './common/tenant-context/request-context.middleware';
import { AppExceptionFilter } from './common/filters/app-exception.filter';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { SessionAuthGuard } from './modules/identity/guards/session-auth.guard';
import { CustomerModule } from './modules/customer/customer.module';
import { CarrierModule } from './modules/carrier/carrier.module';
import { DocumentModule } from './modules/document/document.module';
import { QuoteLoadModule } from './modules/quote-load/quote-load.module';
import { BillingModule } from './modules/billing/billing.module';
import { CarrierPayModule } from './modules/carrier-pay/carrier-pay.module';
import { NotificationModule } from './modules/notification/notification.module';
import { BackgroundJobsModule } from './modules/background-jobs/background-jobs.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ImportModule } from './modules/import/import.module';

/**
 * Root module.
 *
 * Phase 0 (Foundation): Prisma/Redis/Storage/Audit infra, health check,
 * request-context middleware, global exception filter.
 * Phase 1 (Identity & Tenancy) adds: IdentityModule (User, Organization,
 * OrganizationMembership, MembershipRole, OrganizationSequence, auth) and
 * registers SessionAuthGuard globally — every route requires an
 * authenticated session unless explicitly marked @Public()
 * (TECHNICAL_ARCHITECTURE.md §2.5/§3 — tenant isolation and authorization
 * implemented from the beginning, not layered on later).
 *
 * Phase 2 (Core Master Data) adds: CustomerModule, CarrierModule,
 * DocumentModule (malware-scan queue/worker included).
 *
 * Phase 3 (Load Lifecycle Core) adds: QuoteLoadModule (Quote, Load, Stop;
 * direct booking + Quote conversion; numbering).
 *
 * Phase 4 (Sourcing & Dispatch) extends QuoteLoadModule in place — no new
 * top-level module. Phase 5 (POD Receipt & Documentation) extends
 * DocumentModule/QuoteLoadModule similarly.
 *
 * Phase 6 (Financials) adds: BillingModule (ChargeTypeDefinition,
 * ChargeLineItem management via LoadService, Invoice + full lifecycle) and
 * CarrierPayModule (CarrierPayment + approval cycle) — two new modules per
 * the locked Phase 6 module-boundary decision (TECHNICAL_ARCHITECTURE.md
 * §1.2's module-ownership table).
 *
 * Phase 7 (Notifications & Background Jobs) adds: NotificationModule
 * (in-app Notification bell) and BackgroundJobsModule (the five scheduled
 * sweeps from TECHNICAL_ARCHITECTURE.md §10, each calling directly into
 * NotificationService/CarrierEligibilityService — Decision 6, no event bus).
 *
 * Phase 8 (Reporting Foundation) adds: ReportingModule — Global Search
 * (§5.4), AR/AP Aging (§21, Decision D14), and a role-aware Dashboard
 * (PRD §9's approved minimal KPI set). The Standard Report Library and
 * Saved Report Views remain deferred to a separately planned future
 * phase. Load Search/export shipped later (Frontend Phase 13), in
 * QuoteLoadModule rather than here — see LoadSearchService.
 *
 * Bulk Import (PRD.md §1.4, §6.9, §10.1, §13) adds: ImportModule
 * (ImportBatch/ImportBatchRow, 8 entity-specific adapters behind one
 * shared pipeline, BullMQ commit worker). DATABASE_DESIGN.md:794 lists
 * ImportBatch as deferred, citing PRD §2 — that citation does not hold up
 * (PRD §2's Explicitly Deferred Features table has no bulk-import entry);
 * treated as a documentation error, tracked separately, not corrected
 * here. Excel Export, Saved Views, and Scheduled/Emailed Reports remain
 * separately deferred/not-yet-built.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    RedisModule,
    StorageModule,
    AuditModule,
    HealthModule,
    IdentityModule,
    CustomerModule,
    CarrierModule,
    DocumentModule,
    QuoteLoadModule,
    BillingModule,
    CarrierPayModule,
    NotificationModule,
    BackgroundJobsModule,
    ReportingModule,
    ImportModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AppExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: SessionAuthGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
