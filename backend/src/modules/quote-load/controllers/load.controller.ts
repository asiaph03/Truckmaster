import {
  Body,
  Controller,
  Get,
  Header,
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
import { UpdateStopsDto } from '../dto/update-stops.dto';
import { LogCheckCallDto } from '../dto/log-check-call.dto';
import { SetRiskStatusDto } from '../dto/set-risk-status.dto';
import { AssignDispatcherDto } from '../dto/assign-dispatcher.dto';
import { AddChargeDto } from '../dto/add-charge.dto';
import { CreateInternalNoteDto } from '../dto/create-internal-note.dto';
import { CreateCommunicationActivityDto } from '../dto/create-communication-activity.dto';
import { RolesGuard } from '../../identity/guards/roles.guard';
import { Roles } from '../../identity/decorators/roles.decorator';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import { FULL_VISIBILITY_ROLES } from '../services/financial-field-shaping';
import { ActivityHistoryService } from '../services/activity-history.service';
import {
  LoadSearchFilters,
  LoadSearchService,
  LoadSearchSort,
  LoadSearchSortDirection,
} from '../services/load-search.service';

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

/**
 * Frontend Phase 7 approved scope — every role except Compliance Reviewer
 * may log an Internal Note / Communication Activity. Matches the tab's own
 * "visible to all roles" rule (view itself carries no @Roles() at all,
 * same as GET :id) — restricting creation further would leave Add buttons
 * visible to roles that can never use them.
 */
const ACTIVITY_LOG_ROLES: MembershipRoleName[] = [
  'ADMIN',
  'OPERATIONS_MANAGER',
  'DISPATCHER',
  'SALES_BOOKING',
  'ACCOUNTING',
];

const LOAD_SEARCH_SORT_KEYS: LoadSearchSort[] = ['loadNumber', 'pickupDate', 'deliveryDate'];

/**
 * Frontend Phase 13 — no `@Query() dto:` class-validator object exists
 * anywhere else in this controller (every route uses individual
 * `@Query('x')` params, matching every other controller in the app), so
 * this mirrors `list()`'s own permissive style: unrecognized `sort`
 * values are treated as "no sort" (falls back to the default
 * `createdAt desc` ordering) rather than throwing, same permissiveness
 * `list()` already has for `status`/`equipmentType`.
 */
function buildLoadSearchFilters(raw: {
  status?: string;
  customerId?: string;
  carrierId?: string;
  dispatcherId?: string;
  equipmentType?: string;
  riskStatus?: string;
  pickupFrom?: string;
  pickupTo?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  q?: string;
  sort?: string;
  sortDirection?: string;
  ids?: string[];
  excludeClosed?: boolean;
}): LoadSearchFilters {
  const sort = LOAD_SEARCH_SORT_KEYS.includes(raw.sort as LoadSearchSort)
    ? (raw.sort as LoadSearchSort)
    : undefined;
  const sortDirection: LoadSearchSortDirection | undefined =
    raw.sortDirection === 'asc' || raw.sortDirection === 'desc' ? raw.sortDirection : undefined;

  return {
    status: raw.status,
    customerId: raw.customerId,
    carrierId: raw.carrierId,
    dispatcherId: raw.dispatcherId,
    equipmentType: raw.equipmentType,
    riskStatus: raw.riskStatus,
    pickupFrom: raw.pickupFrom,
    pickupTo: raw.pickupTo,
    deliveryFrom: raw.deliveryFrom,
    deliveryTo: raw.deliveryTo,
    q: raw.q,
    sort,
    sortDirection,
    ids: raw.ids,
    excludeClosed: raw.excludeClosed,
  };
}

/**
 * Frontend Phase 18 — Express's default `qs` query parser returns a bare
 * string for a single repeated-key occurrence (`ids=a` → `"a"`) and only
 * returns an array once the key repeats (`ids=a&ids=b` → `["a","b"]`).
 * Verified directly against the `qs` package before writing this, rather
 * than assumed. Normalizes both shapes (plus the not-present case) to a
 * single consistent `string[] | undefined`.
 */
function normalizeIds(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : [raw];
}

function parsePagination(
  pageParam?: string,
  pageSizeParam?: string,
): { page: number; pageSize: number } {
  const page = Number(pageParam);
  const pageSize = Number(pageSizeParam);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 50,
  };
}

@Controller('loads')
@UseGuards(RolesGuard)
export class LoadController {
  constructor(
    private readonly loadService: LoadService,
    private readonly carrierSourcing: CarrierSourcingService,
    private readonly dispatchTracking: DispatchTrackingService,
    private readonly activityHistory: ActivityHistoryService,
    private readonly loadSearch: LoadSearchService,
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

  // Frontend Phase 13 — Load Search. A dedicated endpoint (not a change to
  // `list()`/`GET /loads` above) per the approved plan: Dispatch Board
  // depends on `GET /loads`'s exact current unpaginated shape, and Load
  // Search needs its own paginated/sortable/CSV-exportable shape covering
  // all loads including Closed. Must be registered before @Get(':id') —
  // same reason as `ready-to-invoice` below.
  @Get('search')
  search(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('dispatcherId') dispatcherId?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('riskStatus') riskStatus?: string,
    @Query('pickupFrom') pickupFrom?: string,
    @Query('pickupTo') pickupTo?: string,
    @Query('deliveryFrom') deliveryFrom?: string,
    @Query('deliveryTo') deliveryTo?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('sortDirection') sortDirection?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadSearch.search(
      organizationId,
      actingUserId,
      actingRoles,
      buildLoadSearchFilters({
        status,
        customerId,
        carrierId,
        dispatcherId,
        equipmentType,
        riskStatus,
        pickupFrom,
        pickupTo,
        deliveryFrom,
        deliveryTo,
        q,
        sort,
        sortDirection,
      }),
      parsePagination(page, pageSize),
    );
  }

  // Export shares the exact same filter/search/sort query params as
  // `search` above (decision: "respects the exact current filters and
  // search criteria"), with no page/pageSize — it always returns every
  // matching row (decision #7). Raw string body + these two headers is
  // sufficient here since no global response-wrapping interceptor exists
  // in this app (confirmed) — no need for @Res()/StreamableFile.
  @Get('search/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="load-search-export.csv"')
  exportSearch(
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('carrierId') carrierId?: string,
    @Query('dispatcherId') dispatcherId?: string,
    @Query('equipmentType') equipmentType?: string,
    @Query('riskStatus') riskStatus?: string,
    @Query('pickupFrom') pickupFrom?: string,
    @Query('pickupTo') pickupTo?: string,
    @Query('deliveryFrom') deliveryFrom?: string,
    @Query('deliveryTo') deliveryTo?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('sortDirection') sortDirection?: string,
    // Frontend Phase 18 — Dispatch Board "Export Selected"/"Export" additions.
    @Query('ids') ids?: string | string[],
    @Query('excludeClosed') excludeClosed?: string,
  ) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.loadSearch.exportCsv(
      organizationId,
      actingUserId,
      actingRoles,
      buildLoadSearchFilters({
        status,
        customerId,
        carrierId,
        dispatcherId,
        equipmentType,
        riskStatus,
        pickupFrom,
        pickupTo,
        deliveryFrom,
        deliveryTo,
        q,
        sort,
        sortDirection,
        ids: normalizeIds(ids),
        excludeClosed: excludeClosed === 'true',
      }),
    );
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

  /**
   * Load Detail's Edit Stops action (Overview tab, Stops card) — a
   * booking-detail correction, not a dispatch-tracking transition, so
   * this uses `QUOTE_LOAD_CREATE_ROLES` (same roles that create these
   * stops via `createDirect`) rather than `SOURCING_DISPATCH_ROLES`.
   * Distinct path shape from `:id/stops/:sequence/*` above — no route
   * ordering conflict.
   */
  @Patch(':id/stops')
  @Roles(...QUOTE_LOAD_CREATE_ROLES)
  updateStops(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStopsDto) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    return this.dispatchTracking.updateStops(organizationId, id, dto, actingUserId);
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

  // --- Frontend Phase 7: Activity History (UI_UX_DESIGN.md §5.4.4, LD-6) --

  @Post(':id/internal-notes')
  @Roles(...ACTIVITY_LOG_ROLES)
  addInternalNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateInternalNoteDto) {
    const actingUserId = RequestContextStore.requireUserId();
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.activityHistory.addInternalNote(organizationId, id, dto, actingUserId);
  }

  @Post(':id/communication-activities')
  @Roles(...ACTIVITY_LOG_ROLES)
  logCommunicationActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommunicationActivityDto,
  ) {
    const actingUserId = RequestContextStore.requireUserId();
    const organizationId = RequestContextStore.requireOrganizationId();
    return this.activityHistory.logCommunicationActivity(organizationId, id, dto, actingUserId);
  }

  // No @Roles() — matches GET :id's own precedent and the locked "Visible
  // to all roles (subject to redaction)" text (UI_UX_DESIGN.md §5.4.4).
  @Get(':id/activity-history')
  getActivityHistory(@Param('id', ParseUUIDPipe) id: string) {
    const organizationId = RequestContextStore.requireOrganizationId();
    const actingUserId = RequestContextStore.requireUserId();
    const actingRoles = (RequestContextStore.current().roles ?? []) as MembershipRoleName[];
    return this.activityHistory.getActivityHistory(organizationId, id, actingUserId, actingRoles);
  }
}
