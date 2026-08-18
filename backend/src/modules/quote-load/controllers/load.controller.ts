import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { LoadService } from '../services/load.service';
import { CarrierSourcingService } from '../services/carrier-sourcing.service';
import { DispatchTrackingService } from '../services/dispatch-tracking.service';
import { CreateLoadDto } from '../dto/create-load.dto';
import { UpdateLoadReferenceNumbersDto } from '../dto/update-load-reference-numbers.dto';
import { LogSourcingAttemptDto } from '../dto/log-sourcing-attempt.dto';
import { AssignCarrierDto } from '../dto/assign-carrier.dto';
import { CarrierRejectedDto } from '../dto/carrier-rejected.dto';
import { GenerateRateConfirmationDto } from '../dto/generate-rate-confirmation.dto';
import { DispatchLoadDto } from '../dto/dispatch-load.dto';
import { UpdateDispatchDto } from '../dto/update-dispatch.dto';
import { StopTimestampDto } from '../dto/stop-timestamp.dto';
import { LogCheckCallDto } from '../dto/log-check-call.dto';
import { SetRiskStatusDto } from '../dto/set-risk-status.dto';
import { AssignDispatcherDto } from '../dto/assign-dispatcher.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Loads resource row. Phase 3 scope:
 * `POST /loads`, `GET /loads`, `GET /loads/:id`, `PATCH /loads/:id`. Phase
 * 4 (this update) adds every Sourcing/Dispatch route anticipated by the
 * comment that used to sit here (begin-sourcing, assign-carrier, dispatch,
 * stops/:seq/arrival, check-calls, risk-status, dispatcher) — the
 * remaining §5.1 routes not yet defined (charges, close, etc.) belong to
 * later phases still.
 */
const QUOTE_LOAD_CREATE_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
];

/**
 * Workflow 5 Cross-Cutting Permissions / Workflow 6 Cross-Cutting
 * Permissions — every Phase 4 sourcing/dispatch action: Admin, Operations
 * Manager, Dispatcher. Sales/Booking is explicitly excluded (view-only per
 * Workflow 5's own text).
 */
const SOURCING_DISPATCH_ROLES: MembershipRoleName[] = ['ADMIN', 'OPERATIONS_MANAGER', 'DISPATCHER'];

@Controller('loads')
@UseGuards(RolesGuard)
export class LoadController {
  constructor(
    private readonly loadService: LoadService,
    private readonly carrierSourcing: CarrierSourcingService,
    private readonly dispatchTracking: DispatchTrackingService,
  ) {}

  @Get()
  list(@Query('status') status?: string, @Query('customerId') customerId?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadService.list(organizationId, actingUserId, actingRoles, { status, customerId });
  }

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadService.findById(organizationId, id, actingUserId, actingRoles);
  }

  @Post()
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  createDirect(@Body() dto: CreateLoadDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.loadService.createDirect(organizationId, dto, actingUserId);
  }

  @Patch(':id')
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  updateReferenceNumbers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoadReferenceNumbersDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.loadService.updateReferenceNumbers(organizationId, id, dto, actingUserId);
  }

  // --- Phase 4: Sourcing (Workflow 5) ---------------------------------

  @Post(':id/begin-sourcing')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  beginSourcing(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierSourcing.beginSourcing(organizationId, id, actingUserId);
  }

  @Post(':id/sourcing-attempts')
  @Roles(...SOURCING_DISPATCH_ROLES)
  logSourcingAttempt(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LogSourcingAttemptDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierSourcing.logSourcingAttempt(organizationId, id, dto, actingUserId);
  }

  @Post(':id/assign-carrier')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  assignCarrier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignCarrierDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierSourcing.assignCarrier(organizationId, id, dto, actingUserId);
  }

  @Post(':id/carrier-rejected')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  carrierRejected(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CarrierRejectedDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierSourcing.carrierRejected(organizationId, id, dto, actingUserId);
  }

  @Post(':id/generate-rate-confirmation')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  generateRateConfirmation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateRateConfirmationDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.carrierSourcing.generateRateConfirmation(organizationId, id, dto, actingUserId);
  }

  // --- Phase 4: Dispatch (Workflow 6) ---------------------------------

  @Post(':id/dispatch')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchLoadDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.dispatch(organizationId, id, dto, actingUserId);
  }

  @Patch(':id/dispatch')
  @Roles(...SOURCING_DISPATCH_ROLES)
  updateDispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDispatchDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.updateDispatch(organizationId, id, dto, actingUserId);
  }

  @Post(':id/stops/:sequence/arrival')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  recordArrival(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: StopTimestampDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.recordArrival(organizationId, id, sequence, dto, actingUserId);
  }

  @Post(':id/stops/:sequence/departure')
  @Roles(...SOURCING_DISPATCH_ROLES)
  @HttpCode(200)
  recordDeparture(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: StopTimestampDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.recordDeparture(organizationId, id, sequence, dto, actingUserId);
  }

  @Post(':id/check-calls')
  @Roles(...SOURCING_DISPATCH_ROLES)
  logCheckCall(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LogCheckCallDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.logCheckCall(organizationId, id, dto, actingUserId);
  }

  @Patch(':id/risk-status')
  @Roles(...SOURCING_DISPATCH_ROLES)
  setRiskStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRiskStatusDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.setRiskStatus(organizationId, id, dto, actingUserId);
  }

  @Patch(':id/dispatcher')
  @Roles(...SOURCING_DISPATCH_ROLES)
  assignDispatcher(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDispatcherDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.assignDispatcher(organizationId, id, dto, actingUserId);
  }
}
