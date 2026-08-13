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
import { CustomerService } from '../services/customer.service';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { UpdateCustomerDto } from '../dto/update-customer.dto';
import { ChangeCustomerStatusDto } from '../dto/change-customer-status.dto';
import { AddCustomerContactDto } from '../dto/add-customer-contact.dto';
import { AddCustomerLocationDto } from '../dto/add-customer-location.dto';
import { AddCustomerRateAgreementDto } from '../dto/add-customer-rate-agreement.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Customers resource row.
 * Permissions per §7 matrix: View = all 5 roles (no @Roles() needed —
 * any authenticated org member); Create/Edit/Change Status/Add sub-
 * resource = Admin, Ops Mgr, Sales/Booking, Accounting — explicitly NOT
 * Dispatcher (blank cell in the matrix, per §7's "blank means
 * unimplemented as an action, not just hidden").
 */
const EDIT_ROLES = ['ADMIN', 'OPERATIONS_MANAGER', 'SALES_BOOKING', 'ACCOUNTING'] as const;

@Controller('customers')
@UseGuards(RolesGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get()
  list(@Query('status') status?: string, @Query('search') search?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.customerService.list(organizationId, { status, search });
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.customerService.findById(organizationId, id);
  }

  @Post()
  @Roles(...EDIT_ROLES)
  create(@Body() dto: CreateCustomerDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.create(organizationId, dto, actingUserId);
  }

  @Patch(':id')
  @Roles(...EDIT_ROLES)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.update(organizationId, id, dto, actingUserId);
  }

  @Post(':id/status')
  @Roles(...EDIT_ROLES)
  @HttpCode(200)
  changeStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeCustomerStatusDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.changeStatus(organizationId, id, dto, actingUserId);
  }

  @Post(':id/contacts')
  @Roles(...EDIT_ROLES)
  addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCustomerContactDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.addContact(organizationId, id, dto, actingUserId);
  }

  @Post(':id/locations')
  @Roles(...EDIT_ROLES)
  addLocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCustomerLocationDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.addLocation(organizationId, id, dto, actingUserId);
  }

  @Post(':id/rate-agreements')
  @Roles(...EDIT_ROLES)
  addRateAgreement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCustomerRateAgreementDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.customerService.addRateAgreement(organizationId, id, dto, actingUserId);
  }
}
