import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CarrierService } from '../services/carrier.service';
import { CreateCarrierDto } from '../dto/create-carrier.dto';
import { UpdateCarrierDto } from '../dto/update-carrier.dto';
import { AddCarrierContactDto } from '../dto/add-carrier-contact.dto';
import { AddCarrierInsuranceDto } from '../dto/add-carrier-insurance.dto';
import { AddFmcsaVerificationDto } from '../dto/add-fmcsa-verification.dto';
import { AddServiceAreaDto } from '../dto/add-service-area.dto';
import { UpdateFactoringInfoDto } from '../dto/update-factoring-info.dto';
import { AddDriverDto } from '../dto/add-driver.dto';
import { AddTruckDto } from '../dto/add-truck.dto';
import { AddTrailerDto } from '../dto/add-trailer.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Carriers resource row / §7 matrix:
 * View = all 5 roles; Create/Edit = Admin/OpsMgr/Dispatcher (NOT Sales/
 * Accounting — a different set than Customer's); compliance/insurance/
 * FMCSA/activation actions require the separately-assignable
 * COMPLIANCE_REVIEWER role (§3.4), layered on top of the five base
 * roles, not a sixth mutually-exclusive one.
 */
const CREATE_EDIT_ROLES = ['ADMIN', 'OPERATIONS_MANAGER', 'DISPATCHER'] as const;

@Controller('carriers')
@UseGuards(RolesGuard)
export class CarrierController {
  constructor(private readonly carrierService: CarrierService) {}

  @Get()
  list(@Query('status') status?: string, @Query('assignmentEligible') assignmentEligible?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.carrierService.list(organizationId, {
      status,
      assignmentEligible:
        assignmentEligible === undefined ? undefined : assignmentEligible === 'true',
    });
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.carrierService.findById(organizationId, id);
  }

  @Post()
  @Roles(...CREATE_EDIT_ROLES)
  create(@Body() dto: CreateCarrierDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.create(organizationId, dto, actingUserId);
  }

  @Patch(':id')
  @Roles(...CREATE_EDIT_ROLES)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCarrierDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.update(organizationId, id, dto, actingUserId);
  }

  @Post(':id/contacts')
  @Roles(...CREATE_EDIT_ROLES)
  addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCarrierContactDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addContact(organizationId, id, dto, actingUserId);
  }

  @Post(':id/insurance')
  @Roles(...CREATE_EDIT_ROLES, 'COMPLIANCE_REVIEWER')
  addInsurance(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCarrierInsuranceDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addInsurance(organizationId, id, dto, actingUserId);
  }

  @Post(':id/fmcsa-verification')
  @Roles('COMPLIANCE_REVIEWER')
  addFmcsaVerification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddFmcsaVerificationDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addFmcsaVerification(organizationId, id, dto, actingUserId);
  }

  @Post(':id/activate')
  @Roles('COMPLIANCE_REVIEWER')
  @HttpCode(200)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.activate(organizationId, id, actingUserId);
  }

  @Post(':id/service-areas')
  @Roles(...CREATE_EDIT_ROLES)
  addServiceArea(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddServiceAreaDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addServiceArea(organizationId, id, dto, actingUserId);
  }

  @Post(':id/drivers')
  @Roles(...CREATE_EDIT_ROLES)
  addDriver(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddDriverDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addDriver(organizationId, id, dto, actingUserId);
  }

  @Post(':id/trucks')
  @Roles(...CREATE_EDIT_ROLES)
  addTruck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTruckDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addTruck(organizationId, id, dto, actingUserId);
  }

  @Post(':id/trailers')
  @Roles(...CREATE_EDIT_ROLES)
  addTrailer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTrailerDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.addTrailer(organizationId, id, dto, actingUserId);
  }

  @Patch(':id/factoring')
  @Roles(...CREATE_EDIT_ROLES)
  upsertFactoring(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFactoringInfoDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierService.upsertFactoringInfo(organizationId, id, dto, actingUserId);
  }
}
