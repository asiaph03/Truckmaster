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
 * Remaining feature modules (Notification, Reporting — §1.2) are deferred
 * beyond Phase 6.
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
