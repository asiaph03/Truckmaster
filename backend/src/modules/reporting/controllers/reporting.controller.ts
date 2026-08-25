import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { ReportingService } from '../services/reporting.service';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';

/** Decision 4 — AR/AP Aging and the Dashboard's financial aggregate are Admin/Accounting/Ops Manager only. */

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

  @Get('reports/ap-aging')
  @Roles(...FINANCIAL_VIEW_ROLES)
  apAging() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.reportingService.apAging(organizationId);
  }

  @Get('dashboard')
  dashboard() {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.reportingService.dashboard(organizationId, actingUserId, actingRoles);
  }
}
