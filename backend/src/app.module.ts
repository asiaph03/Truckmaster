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
 * Remaining feature modules (Customer, Carrier, Quote/Load, Sourcing,
 * Dispatch, Document, Billing, CarrierPay, Notification, Reporting —
 * §1.2) are added one at a time starting Phase 2.
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
