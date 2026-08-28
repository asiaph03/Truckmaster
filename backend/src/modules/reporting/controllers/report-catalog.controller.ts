import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import {
  ReportCatalogService,
  OPERATIONS_REPORT_ROLES,
  CARRIER_PERFORMANCE_VIEW_ROLES,
  SALES_PERFORMANCE_VIEW_ROLES,
} from '../services/report-catalog.service';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

function parsePagination(
  pageParam?: string,
  pageSizeParam?: string,
): { page: number; pageSize: number } {
  const page = Number(pageParam);
  const pageSize = Number(pageSizeParam);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 50,
  };
}

/**
 * Phase 21 (Reports Library) — the 8 new catalog reports approved in the
 * Phase 21 plan, plus the role-aware `GET /reports/catalog` listing.
 * AR/AP Aging's own `GET /reports/ar-aging`/`ap-aging` routes stay on
 * `ReportingController`, untouched; this controller only adds their
 * `/export` siblings.
 */
@Controller('reports')
@UseGuards(RolesGuard)
export class ReportCatalogController {
  constructor(private readonly reportCatalog: ReportCatalogService) {}

  // No @Roles() — filters internally, mirrors `dashboard`/`search`.
  @Get('catalog')
  catalog() {
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportCatalog.catalog(actingRoles);
  }

  @Get('payment-history')
  @Roles(...FINANCIAL_VIEW_ROLES)
  paymentHistory(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('type') type?: 'PAYMENT' | 'ADJUSTMENT',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.paymentHistory(
      organizationId,
      { dateFrom, dateTo, customerId, type },
      parsePagination(page, pageSize),
    );
  }

  @Get('payment-history/export')
  @Roles(...FINANCIAL_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="payment-history.csv"')
  paymentHistoryExport(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('type') type?: 'PAYMENT' | 'ADJUSTMENT',
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.paymentHistoryCsv(organizationId, {
      dateFrom,
      dateTo,
      customerId,
      type,
    });
  }

  @Get('revenue-margin')
  @Roles(...FINANCIAL_VIEW_ROLES)
  revenueMargin(
    @Query('groupBy') groupBy: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('compare') compare?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.revenueMargin(
      organizationId,
      groupBy,
      { dateFrom, dateTo, customerId, carrierId, equipmentType },
      parsePagination(page, pageSize),
      compare === 'true',
    );
  }

  @Get('revenue-margin/export')
  @Roles(...FINANCIAL_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="revenue-margin.csv"')
  revenueMarginExport(
    @Query('groupBy') groupBy: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.revenueMarginCsv(organizationId, groupBy, {
      dateFrom,
      dateTo,
      customerId,
      carrierId,
      equipmentType,
    });
  }

  @Get('load-volume')
  @Roles(...OPERATIONS_REPORT_ROLES)
  loadVolume(
    @Query('bucket') bucket = 'MONTH',
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.loadVolume(
      organizationId,
      { bucket: bucket as never, dateFrom, dateTo, customerId, equipmentType },
      parsePagination(page, pageSize),
    );
  }

  @Get('load-volume/export')
  @Roles(...OPERATIONS_REPORT_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="load-volume.csv"')
  loadVolumeExport(
    @Query('bucket') bucket = 'MONTH',
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('customerId') customerId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.loadVolumeCsv(organizationId, {
      bucket: bucket as never,
      dateFrom,
      dateTo,
      customerId,
      equipmentType,
    });
  }

  @Get('status-mix')
  @Roles(...OPERATIONS_REPORT_ROLES)
  statusMix(
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.statusMix(organizationId, { customerId, carrierId, equipmentType });
  }

  @Get('status-mix/export')
  @Roles(...OPERATIONS_REPORT_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="status-mix.csv"')
  statusMixExport(
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.statusMixCsv(organizationId, {
      customerId,
      carrierId,
      equipmentType,
    });
  }

  @Get('on-time-performance')
  @Roles(...OPERATIONS_REPORT_ROLES)
  onTimePerformance(
    @Query('groupBy') groupBy: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.onTimePerformance(
      organizationId,
      groupBy,
      { dateFrom, dateTo, carrierId, equipmentType },
      parsePagination(page, pageSize),
    );
  }

  @Get('on-time-performance/export')
  @Roles(...OPERATIONS_REPORT_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="on-time-performance.csv"')
  onTimePerformanceExport(
    @Query('groupBy') groupBy: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('carrierId') carrierId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.onTimePerformanceCsv(organizationId, groupBy, {
      dateFrom,
      dateTo,
      carrierId,
      equipmentType,
    });
  }

  @Get('dispatcher-workload')
  @Roles(...OPERATIONS_REPORT_ROLES)
  dispatcherWorkload(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.dispatcherWorkload(
      organizationId,
      { dateFrom, dateTo },
      parsePagination(page, pageSize),
    );
  }

  @Get('dispatcher-workload/export')
  @Roles(...OPERATIONS_REPORT_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="dispatcher-workload.csv"')
  dispatcherWorkloadExport(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportCatalog.dispatcherWorkloadCsv(organizationId, { dateFrom, dateTo });
  }

  @Get('carrier-performance')
  @Roles(...CARRIER_PERFORMANCE_VIEW_ROLES)
  carrierPerformance(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportCatalog.carrierPerformance(
      organizationId,
      actingRoles,
      { dateFrom, dateTo, equipmentType },
      parsePagination(page, pageSize),
    );
  }

  @Get('carrier-performance/export')
  @Roles(...CARRIER_PERFORMANCE_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="carrier-performance.csv"')
  carrierPerformanceExport(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportCatalog.carrierPerformanceCsv(organizationId, actingRoles, {
      dateFrom,
      dateTo,
      equipmentType,
    });
  }

  @Get('sales-performance')
  @Roles(...SALES_PERFORMANCE_VIEW_ROLES)
  salesPerformance(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportCatalog.salesPerformance(
      organizationId,
      actingUserId,
      actingRoles,
      { dateFrom, dateTo },
      parsePagination(page, pageSize),
    );
  }

  @Get('sales-performance/export')
  @Roles(...SALES_PERFORMANCE_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="sales-performance.csv"')
  salesPerformanceExport(@Query('dateFrom') dateFrom?: string, @Query('dateTo') dateTo?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportCatalog.salesPerformanceCsv(organizationId, actingUserId, actingRoles, {
      dateFrom,
      dateTo,
    });
  }
}
