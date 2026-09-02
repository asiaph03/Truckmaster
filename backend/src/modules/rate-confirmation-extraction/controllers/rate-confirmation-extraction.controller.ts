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
import { MembershipRoleName } from '@prisma/client';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { RateConfirmationExtractionService } from '../services/rate-confirmation-extraction.service';
import { InitiateRateConfirmationExtractionDto } from '../dto/initiate-rate-confirmation-extraction.dto';

/**
 * Rate Confirmation → New Load auto-populate feature. Same role set as
 * Load creation (`QUOTE_LOAD_CREATE_ROLES`, load.controller.ts) — this is
 * a booking-adjacent action performed by the same actors, duplicated
 * here since that constant is controller-local (mirrors the identical
 * duplication already made in document.service.ts's
 * RATE_CONFIRMATION_INTAKE_UPLOAD_ROLES for the same reason).
 */
const RATE_CONFIRMATION_EXTRACTION_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
];

@Controller('rate-confirmation-extractions')
@UseGuards(RolesGuard)
@Roles(...RATE_CONFIRMATION_EXTRACTION_ROLES)
export class RateConfirmationExtractionController {
  constructor(private readonly extractionService: RateConfirmationExtractionService) {}

  @Post()
  initiate(@Body() dto: InitiateRateConfirmationExtractionDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.extractionService.initiate(organizationId, dto, actingUserId);
  }

  @Post(':id/confirm')
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.extractionService.confirm(organizationId, id, actingUserId);
  }

  @Get(':id')
  getStatus(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.extractionService.getStatus(organizationId, id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.extractionService.retry(organizationId, id);
  }
}
