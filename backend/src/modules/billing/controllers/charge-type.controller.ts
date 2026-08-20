import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { ChargeTypeService } from '../services/charge-type.service';
import { CreateChargeTypeDto } from '../dto/create-charge-type.dto';
import { UpdateChargeTypeDto } from '../dto/update-charge-type.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * Decision Log B3 — Admin-only management. List is readable by every role
 * that can add a charge to a Load (Decision Log D9), so the charge-type
 * picker resolves for all of them.
 */
const CHARGE_TYPE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'ACCOUNTING',
];

@Controller('charge-types')
@UseGuards(RolesGuard)
export class ChargeTypeController {
  constructor(private readonly chargeTypeService: ChargeTypeService) {}

  @Get()
  @Roles(...CHARGE_TYPE_VIEW_ROLES)
  list() {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.chargeTypeService.list(organizationId);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateChargeTypeDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.chargeTypeService.create(organizationId, dto, actingUserId);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChargeTypeDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.chargeTypeService.update(organizationId, id, dto, actingUserId);
  }
}
