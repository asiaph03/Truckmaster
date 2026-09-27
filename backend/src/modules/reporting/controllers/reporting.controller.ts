import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { ReportingService } from '../services/reporting.service';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';

/** Decision 4 — AR/AP Aging and the Dashboard's financial aggregate are Admin/Accounting/Ops Manager only. */

/** B.5 — mirrors LoadController's own page/pageSize parsing exactly, except the default pageSize (25) matches this endpoint's pre-existing implicit limit rather than LoadSearch's own default (50). */
const NEEDS_ATTENTION_DEFAULT_PAGE_SIZE = 25;

function parseNeedsAttentionPagination(
  pageParam?: string,
  pageSizeParam?: string,
): { page: number; pageSize: number } {
  const page = Number(pageParam);
  const pageSize = Number(pageSizeParam);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize:
      Number.isFinite(pageSize) && pageSize > 0
        ? Math.floor(pageSize)
        : NEEDS_ATTENTION_DEFAULT_PAGE_SIZE,
  };
}

/**
 * Phase 8 (Reporting Foundation) — TECHNICAL_ARCHITECTURE.md §5.1 Reporting
 * resource row. `search`/`dashboard` are open to any authenticated session
 * (§5.4 — "results are filtered, not the endpoint"; Dashboard content
 * varies by role internally, per UI_UX_DESIGN.md's nav table). Only the
 * AR/AP Aging routes are guard-gated.
 */
@Controller()
@UseGuards(RolesGuard)
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get('search')
  search(@Query('q') q: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportingService.search(organizationId, q ?? '', actingUserId, actingRoles);
  }

  @Get('reports/ar-aging')
  @Roles(...FINANCIAL_VIEW_ROLES)
  arAging() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportingService.arAging(organizationId);
  }

  // Phase 21 (Reports Library) — identical data/authorization as
  // `arAging` above, as CSV, so AR Aging participates in the library's
  // export behavior without a second implementation.
  @Get('reports/ar-aging/export')
  @Roles(...FINANCIAL_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="ar-aging.csv"')
  arAgingExport() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportingService.arAgingCsv(organizationId);
  }

  @Get('reports/ap-aging')
  @Roles(...FINANCIAL_VIEW_ROLES)
  apAging() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportingService.apAging(organizationId);
  }

  @Get('reports/ap-aging/export')
  @Roles(...FINANCIAL_VIEW_ROLES)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="ap-aging.csv"')
  apAgingExport() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportingService.apAgingCsv(organizationId);
  }

  @Get('dashboard')
  dashboard() {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportingService.dashboard(organizationId, actingUserId, actingRoles);
  }

  @Get('dashboard/fleet-map')
  fleetMap() {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportingService.fleetMap(organizationId, actingUserId, actingRoles);
  }

  @Get('dashboard/needs-attention')
  needsAttention(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    const pagination = parseNeedsAttentionPagination(page, pageSize);
    return this.reportingService.needsAttention(
      organizationId,
      actingUserId,
      actingRoles,
      pagination.page,
      pagination.pageSize,
    );
  }
}
