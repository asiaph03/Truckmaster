import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { OrganizationService } from '../services/organization.service';
import { UpdateOrganizationDto } from '../dto/update-organization.dto';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * Frontend Phase 14 — Organization Settings. Deliberately a separate
 * controller/route prefix (`organizations`, not `platform/organizations`)
 * from OrganizationsController, which stays platform-console-only,
 * guarded by PlatformSuperAdminGuard, and is unmodified by this phase.
 * Every route here is organization-scoped: organizationId always comes
 * from RequestContext, never a path/query/body parameter — same
 * convention as MembershipsController.
 */
@Controller('organizations')
@UseGuards(RolesGuard)
export class OrganizationSettingsController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('current')
  @Roles('ADMIN')
  getCurrent() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.organizationService.getCurrent(organizationId);
  }

  @Patch('current')
  @Roles('ADMIN')
  update(@Body() dto: UpdateOrganizationDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.organizationService.update(organizationId, dto, actingUserId);
  }
}
