import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { CarrierPaymentService } from '../services/carrier-payment.service';
import { CreateCarrierPaymentDto } from '../dto/create-carrier-payment.dto';
import { RejectCarrierPaymentDto } from '../dto/reject-carrier-payment.dto';
import { MarkPaidDto } from '../dto/mark-paid.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { FINANCIAL_VIEW_ROLES } from '../../../common/authorization/financial-view-roles';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Carrier Pay resource. `GET /carrier-payments`
 * and `GET /carrier-payments/:id` are not in §5.1's representative table but
 * are structurally required to view/approve records at all — added here,
 * mirroring the Invoice resource's own GET routes exactly (disclosed as an
 * additive, non-business-rule read-endpoint gap-fill, not a scope
 * expansion).
 */
const PREPARE_ROLES: MembershipRoleName[] = ['ADMIN', 'ACCOUNTING'];

@Controller()
@UseGuards(RolesGuard)
export class CarrierPaymentController {
  constructor(private readonly carrierPaymentService: CarrierPaymentService) {}

  @Post('loads/:id/carrier-payments')
  @Roles(...PREPARE_ROLES)
  create(@Param('id', ParseUUIDPipe) loadId: string, @Body() dto: CreateCarrierPaymentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierPaymentService.create(organizationId, loadId, dto, actingUserId);
  }

  @Get('carrier-payments')
  @Roles(...FINANCIAL_VIEW_ROLES)
  list(@Query('loadId') loadId?: string, @Query('status') status?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.carrierPaymentService.list(organizationId, actingRoles, { loadId, status });
  }

  @Get('carrier-payments/:id')
  @Roles(...FINANCIAL_VIEW_ROLES)
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.carrierPaymentService.findById(organizationId, id, actingRoles);
  }

  @Post('carrier-payments/:id/submit')
  @Roles(...PREPARE_ROLES)
  @HttpCode(200)
  submit(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierPaymentService.submit(organizationId, id, actingUserId);
  }

  @Post('carrier-payments/:id/approve')
  @Roles('ADMIN')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierPaymentService.approve(organizationId, id, actingUserId);
  }

  @Post('carrier-payments/:id/reject')
  @Roles('ADMIN')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectCarrierPaymentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierPaymentService.reject(organizationId, id, dto, actingUserId);
  }

  @Post('carrier-payments/:id/mark-paid')
  @Roles(...PREPARE_ROLES)
  @HttpCode(200)
  markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPaidDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierPaymentService.markPaid(organizationId, id, dto, actingUserId);
  }
}
