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
import { RescheduleStopDto } from '../dto/reschedule-stop.dto';
import { LogCheckCallDto } from '../dto/log-check-call.dto';
import { SetRiskStatusDto } from '../dto/set-risk-status.dto';
import { AssignDispatcherDto } from '../dto/assign-dispatcher.dto';
import { AddChargeDto } from '../dto/add-charge.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { FULL_VISIBILITY_ROLES } from '../services/financial-field-shaping';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Loads resource row. Phase 3: `POST
 * /loads`, `GET /loads`, `GET /loads/:id`, `PATCH /loads/:id`. Phase 4
 * added every Sourcing/Dispatch route (begin-sourcing, assign-carrier,
 * dispatch, stops/:seq/arrival, check-calls, risk-status, dispatcher).
 * Phase 6 (this update) adds the remaining §5.1 Loads routes: `charges`,
 * `close`, and `ready-to-invoice` — every route this resource anticipates
 * is now defined.
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

/** Decision Log D9 — Add Charge: Admin, Operations Manager, Dispatcher, Accounting. */
const ADD_CHARGE_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'ACCOUNTING',
];

/** Workflow 10 Cross-Cutting Permissions — view checklist / Close: Admin, Ops Manager, Accounting. Not Dispatcher. */
const LOAD_CLOSING_ROLES: MembershipRoleName[] = ['ADMIN', 'OPERATIONS_MANAGER', 'ACCOUNTING'];

@Controller('loads')
@UseGuards(RolesGuard)
export class LoadController {
  constructor(
    private readonly loadService: LoadService,
    private readonly carrierSourcing: CarrierSourcingService,
    private readonly dispatchTracking: DispatchTrackingService,
  ) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('dispatcherId') dispatcherId?: string,
    @Query('equipmentType') equipmentType?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadService.list(organizationId, actingUserId, actingRoles, {
      status,
      customerId,
      carrierId,
      dispatcherId,
      equipmentType,
    });
  }

  // Must be registered before @Get(':id') — a static path segment has to
  // precede a dynamic :id route, or NestJS's :id param would greedily
  // match "ready-to-invoice" as an id.
  //
  // Post-Phase-8 remediation (Priority 1) — this is a Financials-specific
  // queue with no legitimate Dispatcher/Sales-Booking use case (unlike
  // GET /loads, where every role has a non-financial reason to see Load
  // data), so it's gated to the same full-financial-visibility role set
  // `shapeFinancialFields` already redacts against, rather than relying on
  // redaction alone.
  @Get('ready-to-invoice')
  @Roles(...FULL_VISIBILITY_ROLES)
  getReadyToInvoice(@Query('customerId') customerId?: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadService.getReadyToInvoice(
      organizationId,
      customerId,
      actingUserId,
      actingRoles,
    );
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

  /**
   * Frontend Phase 6 approved gap-fix — Dispatch Board Calendar's
   * drag-to-reschedule. Same `SOURCING_DISPATCH_ROLES` as every other
   * dispatch-mutating route on this controller (Decision DB-C-4's own
   * "Admin, Operations Manager, Dispatcher" list matches exactly — no
   * new permission key needed).
   */
  @Patch(':id/stops/:sequence/reschedule')
  @Roles(...SOURCING_DISPATCH_ROLES)
  rescheduleStop(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sequence', ParseIntPipe) sequence: number,
    @Body() dto: RescheduleStopDto,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.rescheduleStop(organizationId, id, sequence, dto, actingUserId);
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

  // --- Phase 6: Financials (Charges D9, Load Closing Workflow 10) ------

  @Post(':id/charges')
  @Roles(...ADD_CHARGE_ROLES)
  addCharge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddChargeDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.loadService.addCharge(organizationId, id, dto, actingUserId);
  }

  @Post(':id/close')
  @Roles(...LOAD_CLOSING_ROLES)
  @HttpCode(200)
  closeLoad(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.loadService.closeLoad(organizationId, id, actingUserId);
  }

  // Frontend Phase 4 gap-fix — read-only preview of the same checklist
  // closeLoad computes, needed so the Closing Readiness card (Overview
  // tab) and the Load Closing screen can show it before the user commits
  // to closing. Same role gate as close itself; mutates nothing.
  @Get(':id/closing-checklist')
  @Roles(...LOAD_CLOSING_ROLES)
  getClosingChecklist(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.loadService.getClosingChecklist(organizationId, id);
  }
}
