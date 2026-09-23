import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { OrganizationService } from '../services/organization.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { ConvertOrganizationSubscriptionDto } from '../dto/convert-organization-subscription.dto';
import { PlatformSuperAdminGuard } from '../guards/platform-super-admin.guard';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { NotFoundError } from '../../../common/errors/app-error';

/**
 * Platform-console route (ARCHITECTURE.md §1.1) — not part of the
 * `/api/v1` org-scoped API surface conceptually, but served from the same
 * backend process per the modular-monolith structure (§1). Guarded by
 * PlatformSuperAdminGuard, not the normal RolesGuard, since this action
 * has no organization context to check roles against yet — it's what
 * *creates* the first organization context.
 *
 * TECHNICAL_ARCHITECTURE.md §5.1 didn't originally list an explicit route
 * for this — see the Phase 1 report's "architectural decisions that
 * required clarification."
 */
@Controller('platform/organizations')
@UseGuards(PlatformSuperAdminGuard)
export class OrganizationsController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Post()
  async create(@Body() dto: CreateOrganizationDto) {
    const actingUserId = RequestContextStore.requireUserId();
    const result = await this.organizationService.createOrganization(dto, actingUserId);
    return { organization: result.organization };
  }

  /** Phase 4 — platform-console org list. Summary projection only. */
  @Get()
  list() {
    return this.organizationService.findAllForPlatformAdmin();
  }

  /**
   * Phase 4 — platform-console org detail, including subscription state
   * and current qualifying carrier/driver counts.
   */
  @Get(':id')
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    const organization = await this.organizationService.findByIdForPlatformAdmin(id);
    if (!organization) throw new NotFoundError('Organization not found.');
    return organization;
  }

  /** Phase 4 — TRIAL/EXPIRED → ACTIVE conversion. */
  @Patch(':id/subscription')
  convertSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertOrganizationSubscriptionDto,
  ) {
    const actingUserId = RequestContextStore.requireUserId();
    return this.organizationService.convertSubscription(id, dto, actingUserId);
  }
}
