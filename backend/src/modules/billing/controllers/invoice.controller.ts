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
import { InvoiceService } from '../services/invoice.service';
import { CreateInvoiceDto } from '../dto/create-invoice.dto';
import { SendInvoiceDto } from '../dto/send-invoice.dto';
import { RecordPaymentDto } from '../dto/record-payment.dto';
import { AddAdjustmentDto } from '../dto/add-adjustment.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Invoices resource. View roles per
 * UI_UX_DESIGN.md §5.4.7's Permission Summary (Admin/Accounting/Ops
 * Manager full view, Sales/Booking own-deal-redacted, Dispatcher/Compliance
 * Reviewer blocked entirely — fine-grained own-deal redaction happens in
 * InvoiceService, this guard is the coarse allow-list). Action roles are
 * Workflow 8's literal actor list: Accounting and Admin only.
 */
const INVOICE_VIEW_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'ACCOUNTING',
  'OPERATIONS_MANAGER',
  'SALES_BOOKING',
];
const INVOICE_ACTION_ROLES: MembershipRoleName[] = ['ADMIN', 'ACCOUNTING'];

@Controller('invoices')
@UseGuards(RolesGuard)
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @Get()
  @Roles(...INVOICE_VIEW_ROLES)
  list(@Query('customerId') customerId?: string, @Query('status') status?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.invoiceService.list(organizationId, actingUserId, actingRoles, {
      customerId,
      status,
    });
  }

  @Get(':id')
  @Roles(...INVOICE_VIEW_ROLES)
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.invoiceService.findById(organizationId, id, actingUserId, actingRoles);
  }

  @Post()
  @Roles(...INVOICE_ACTION_ROLES)
  create(@Body() dto: CreateInvoiceDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.invoiceService.create(organizationId, dto, actingUserId);
  }

  @Post(':id/send')
  @Roles(...INVOICE_ACTION_ROLES)
  @HttpCode(200)
  send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendInvoiceDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.invoiceService.send(organizationId, id, dto, actingUserId);
  }

  @Post(':id/payments')
  @Roles(...INVOICE_ACTION_ROLES)
  recordPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.invoiceService.recordPayment(organizationId, id, dto, actingUserId);
  }

  @Post(':id/adjustments')
  @Roles(...INVOICE_ACTION_ROLES)
  addAdjustment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddAdjustmentDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.invoiceService.addAdjustment(organizationId, id, dto, actingUserId);
  }

  @Post(':id/void')
  @Roles(...INVOICE_ACTION_ROLES)
  @HttpCode(200)
  void(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.invoiceService.void(organizationId, id, actingUserId);
  }
}
