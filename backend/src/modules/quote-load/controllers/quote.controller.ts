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
import { QuoteService } from '../services/quote.service';
import { CreateQuoteDto } from '../dto/create-quote.dto';
import { MarkQuoteLostDto } from '../dto/mark-quote-lost.dto';
import { ConvertQuoteDto } from '../dto/convert-quote.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Quotes resource row.
 * Permissions per §7 matrix "Create Quote / Direct Booking": Admin, Ops
 * Manager, Dispatcher, Sales/Booking — explicitly NOT Accounting.
 * Workflow 4's own Cross-Cutting Permissions section: "Marking a Quote
 * Lost, confirming a rate during conversion... all require the same
 * creation permission — no additional distinct permission introduced" —
 * so mark-lost/convert use the same role set as create. View = no
 * @Roles() (any authenticated org member), matching Customer/Carrier;
 * financial-field visibility is shaped per-role inside the service, not
 * gated here.
 */
const QUOTE_LOAD_CREATE_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
];

@Controller('quotes')
@UseGuards(RolesGuard)
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  @Get()
  list(@Query('status') status?: string, @Query('customerId') customerId?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.quoteService.list(organizationId, actingUserId, actingRoles, {
      status,
      customerId,
    });
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.quoteService.findById(organizationId, id, actingUserId, actingRoles);
  }

  @Post()
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  create(@Body() dto: CreateQuoteDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.quoteService.create(organizationId, dto, actingUserId);
  }

  @Post(':id/mark-lost')
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  @HttpCode(200)
  markLost(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkQuoteLostDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.quoteService.markLost(organizationId, id, dto, actingUserId);
  }

  @Post(':id/convert')
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  @HttpCode(200)
  convert(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConvertQuoteDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.quoteService.convert(organizationId, id, dto, actingUserId);
  }
}
