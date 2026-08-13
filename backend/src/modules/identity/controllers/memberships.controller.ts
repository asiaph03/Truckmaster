import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MembershipService } from '../services/membership.service';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Users/Memberships resource row. All
 * routes here are organization-scoped (SessionAuthGuard + RolesGuard,
 * applied at the module level — see identity.module.ts) — organizationId
 * always comes from RequestContext (§3.5), never a path/body parameter.
 */
@Controller('memberships')
@UseGuards(RolesGuard)
export class MembershipsController {
  constructor(private readonly membershipService: MembershipService) {}

  @Get()
  async list() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.membershipService.listMemberships(organizationId);
  }

  @Post('invite')
  @Roles('ADMIN')
  async invite(@Body() dto: InviteMemberDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.membershipService.invite(organizationId, dto, actingUserId);
  }

  @Post(':id/resend')
  @Roles('ADMIN')
  @HttpCode(200)
  async resend(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.membershipService.resend(organizationId, id, actingUserId);
  }

  @Post(':id/cancel')
  @Roles('ADMIN')
  @HttpCode(200)
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.membershipService.cancel(organizationId, id, actingUserId);
  }

  @Post(':id/deactivate')
  @Roles('ADMIN')
  @HttpCode(200)
  async deactivate(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.membershipService.deactivate(organizationId, id, actingUserId);
  }
}
