import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { LoadDraftService } from '../services/load-draft.service';
import { CreateLoadDraftDto } from '../dto/create-load-draft.dto';

/**
 * Rate Confirmation → New Load auto-populate feature. Same role set as
 * Load creation (`QUOTE_LOAD_CREATE_ROLES`, load.controller.ts) — this is
 * a booking-adjacent action performed by the same actors, duplicated
 * here since that constant is controller-local (mirrors the identical
 * duplication in rate-confirmation-extraction.controller.ts for the same
 * reason).
 */
const QUOTE_LOAD_CREATE_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
];

@Controller('load-drafts')
@UseGuards(RolesGuard)
@Roles(...QUOTE_LOAD_CREATE_ROLES)
export class LoadDraftController {
  constructor(private readonly loadDraftService: LoadDraftService) {}

  @Post()
  create(@Body() dto: CreateLoadDraftDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.loadDraftService.create(organizationId, actingUserId, dto);
  }

  @Get()
  list() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.loadDraftService.list(organizationId);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.loadDraftService.get(organizationId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const organizationId = RequestContextStore.requireOrganizationId();
    await this.loadDraftService.delete(organizationId, id);
  }
}
