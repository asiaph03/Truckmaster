import { DispatchTrackingService } from './dispatch-tracking.service';
import { LoadStatusDerivationService } from './load-status-derivation.service';
import {
  BusinessRuleError,
  EligibilityError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const LOAD_ID = 'load-1';
const USER_ID = 'user-1';

function buildService(opts: {
  load?: Record<string, unknown> | null;
  stops?: Record<string, unknown>[];
  dispatchRecord?: Record<string, unknown> | null;
  rateConfirmationDoc?: Record<string, unknown> | null;
  eligibility?: { eligible: boolean; reasons: string[] };
  membership?: Record<string, unknown> | null;
}) {
  const defaultLoad = {
    id: LOAD_ID,
    status: 'RATE_CONFIRMATION',
    assignedCarrierId: 'carrier-1',
    carrierRate: { toString: () => '2000.00' },
    riskStatus: 'NORMAL',
    riskReason: null,
    assignedDispatcherId: null,
    currentLocationCity: null,
    currentLocationState: null,
    currentLocationZip: null,
    currentEta: null,
  };

  const tx = {
    load: {
      findFirst: jest.fn().mockResolvedValue('load' in opts ? opts.load : defaultLoad),
      update: jest.fn().mockImplementation(({ data }) => ({
        ...('load' in opts ? opts.load : defaultLoad),
        ...data,
      })),
    },
    stop: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { sequence: number } }) =>
          (opts.stops ?? []).find((s) => s.sequence === where.sequence),
        ),
      findMany: jest.fn().mockResolvedValue(opts.stops ?? []),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const existing = (opts.stops ?? []).find((s) => s.id === where.id);
        // Mutate in place so a subsequent findMany() (used by
        // reEvaluateLoadStatus to re-derive Load status) sees this change —
        // matching real Postgres read-your-writes behavior inside one tx.
        return Object.assign(existing ?? {}, data);
      }),
    },
    dispatchRecord: {
      create: jest.fn().mockResolvedValue(undefined),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'dispatchRecord' in opts
            ? opts.dispatchRecord
            : { loadId: LOAD_ID, dispatchedAt: new Date('2026-01-01T00:00:00Z') },
        ),
      update: jest.fn().mockImplementation(({ data }) => ({ loadId: LOAD_ID, ...data })),
    },
    checkCall: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'checkcall-1', ...data })),
    },
    document: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'rateConfirmationDoc' in opts ? opts.rateConfirmationDoc : { id: 'doc-1' },
        ),
    },
    organizationMembership: {
      findFirst: jest
        .fn()
        .mockResolvedValue('membership' in opts ? opts.membership : { id: 'membership-1' }),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const carrierEligibility = {
    recalculate: jest.fn().mockResolvedValue(opts.eligibility ?? { eligible: true, reasons: [] }),
  };
  const statusDerivation = new LoadStatusDerivationService();

  const service = new DispatchTrackingService(
    prisma as never,
    audit as never,
    carrierEligibility as never,
    statusDerivation,
  );

  return { service, tx, audit, carrierEligibility };
}

const DISPATCH_DTO = {
  driverName: 'Jane Driver',
  driverPhone: '555-1234',
  truckNumber: 'T-1',
  trailerNumber: 'TR-1',
};

describe('DispatchTrackingService.dispatch — Workflow 6 §6.1', () => {
  it('dispatches when the full gate is satisfied, snapshots the DispatchRecord, and audits', async () => {
    const { service, tx, audit } = buildService({});

    const load = await service.dispatch(ORG_ID, LOAD_ID, DISPATCH_DTO, USER_ID);

    expect(load.status).toBe('DISPATCHED');
    expect(tx.dispatchRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ driverName: 'Jane Driver', trailerNumber: 'TR-1' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Load Dispatched' }),
    );
  });

  it('blocks when the Load has not reached RATE_CONFIRMATION', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'CARRIER_ASSIGNED' } });

    await expect(service.dispatch(ORG_ID, LOAD_ID, DISPATCH_DTO, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('re-validates carrier eligibility live and blocks if no longer eligible', async () => {
    const { service, carrierEligibility } = buildService({
      eligibility: { eligible: false, reasons: ['COI expired'] },
    });

    await expect(service.dispatch(ORG_ID, LOAD_ID, DISPATCH_DTO, USER_ID)).rejects.toThrow(
      EligibilityError,
    );
    expect(carrierEligibility.recalculate).toHaveBeenCalled();
  });

  it('blocks when no Rate Confirmation is on file', async () => {
    const { service } = buildService({ rateConfirmationDoc: null });

    await expect(service.dispatch(ORG_ID, LOAD_ID, DISPATCH_DTO, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });
});

describe('DispatchTrackingService.updateDispatch — Workflow 6 §6.9', () => {
  it('audits a field-level diff when values actually change', async () => {
    const { service, audit } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED' },
      dispatchRecord: { loadId: LOAD_ID, driverName: 'Old Name' },
    });

    await service.updateDispatch(ORG_ID, LOAD_ID, { driverName: 'New Name' }, USER_ID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Dispatch Information Changed' }),
    );
  });

  it('rejects editing before the Load has been Dispatched', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'RATE_CONFIRMATION' } });

    await expect(
      service.updateDispatch(ORG_ID, LOAD_ID, { driverName: 'New Name' }, USER_ID),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe('DispatchTrackingService.recordArrival/recordDeparture — Workflow 6 §6.4/§6.5/§6.6', () => {
  it('records arrival, advances DISPATCHED -> PICKUP for a single-pickup load', async () => {
    const stops = [
      { id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' },
      { id: 'stop-2', sequence: 2, stopType: 'DELIVERY', status: 'PENDING' },
    ];
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED' },
      stops,
    });

    const { stop, load } = await service.recordArrival(ORG_ID, LOAD_ID, 1, {}, USER_ID);

    expect(stop.status).toBe('ARRIVED');
    expect(load.status).toBe('PICKUP');
  });

  it('rejects arrival on a Stop that already has one recorded', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'ARRIVED' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    await expect(service.recordArrival(ORG_ID, LOAD_ID, 1, {}, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects recording progress before the Load has been Dispatched', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'RATE_CONFIRMATION' } });

    await expect(service.recordArrival(ORG_ID, LOAD_ID, 1, {}, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('advances PICKUP -> IN_TRANSIT only once every pickup stop is COMPLETED', async () => {
    const stops = [
      {
        id: 'stop-1',
        sequence: 1,
        stopType: 'PICKUP',
        status: 'ARRIVED',
        actualArrival: new Date(),
      },
      { id: 'stop-2', sequence: 2, stopType: 'PICKUP', status: 'COMPLETED' },
      { id: 'stop-3', sequence: 3, stopType: 'DELIVERY', status: 'PENDING' },
    ];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'PICKUP' }, stops });

    const { load } = await service.recordDeparture(ORG_ID, LOAD_ID, 1, {}, USER_ID);

    expect(load.status).toBe('IN_TRANSIT');
  });

  it('advances IN_TRANSIT -> DELIVERED once the final-by-sequence delivery completes', async () => {
    const stops = [
      { id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'COMPLETED' },
      {
        id: 'stop-2',
        sequence: 2,
        stopType: 'DELIVERY',
        status: 'ARRIVED',
        actualArrival: new Date(),
      },
    ];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' }, stops });

    const { load } = await service.recordDeparture(ORG_ID, LOAD_ID, 2, {}, USER_ID);

    expect(load.status).toBe('DELIVERED');
  });

  it('rejects departure before an arrival has been recorded', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    await expect(service.recordDeparture(ORG_ID, LOAD_ID, 1, {}, USER_ID)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects a departure timestamp that precedes the recorded arrival', async () => {
    const stops = [
      {
        id: 'stop-1',
        sequence: 1,
        stopType: 'PICKUP',
        status: 'ARRIVED',
        actualArrival: new Date('2026-01-02T00:00:00Z'),
      },
    ];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    await expect(
      service.recordDeparture(ORG_ID, LOAD_ID, 1, { timestamp: '2026-01-01T00:00:00Z' }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('DispatchTrackingService.rescheduleStop — Frontend Phase 6 gap-fix (Calendar drag-to-reschedule)', () => {
  it('updates appointmentDatetime on a PENDING stop and audits the previous/new values', async () => {
    const stops = [
      {
        id: 'stop-1',
        sequence: 1,
        stopType: 'PICKUP',
        status: 'PENDING',
        appointmentDatetime: new Date('2026-01-01T10:00:00Z'),
      },
    ];
    const { service, tx, audit } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops,
    });

    const updated = await service.rescheduleStop(
      ORG_ID,
      LOAD_ID,
      1,
      { appointmentDatetime: '2026-01-02T10:00:00Z' },
      USER_ID,
    );

    expect(updated.appointmentDatetime).toEqual(new Date('2026-01-02T10:00:00Z'));
    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { appointmentDatetime: new Date('2026-01-02T10:00:00Z') },
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Stop Rescheduled',
        previousValue: { sequence: 1, appointmentDatetime: new Date('2026-01-01T10:00:00Z') },
        newValue: { sequence: 1, appointmentDatetime: new Date('2026-01-02T10:00:00Z') },
      }),
    );
  });

  it('never touches Stop.status — a pure reschedule, not a general edit', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' }];
    const { service, tx } = buildService({ load: { id: LOAD_ID, status: 'BOOKED' }, stops });

    await service.rescheduleStop(
      ORG_ID,
      LOAD_ID,
      1,
      { appointmentDatetime: '2026-01-02T10:00:00Z' },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { appointmentDatetime: expect.any(Date) } }),
    );
  });

  it('rejects rescheduling an ARRIVED stop', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'ARRIVED' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        1,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects rescheduling a COMPLETED stop', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'COMPLETED' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' }, stops });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        1,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects any reschedule on a DELIVERED Load, even for a still-PENDING stop (multi-delivery edge case)', async () => {
    const stops = [{ id: 'stop-1', sequence: 2, stopType: 'DELIVERY', status: 'PENDING' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DELIVERED' }, stops });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        2,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('rejects any reschedule on a CLOSED Load', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'CLOSED' }, stops });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        1,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('throws NotFoundError for a Load outside the organization', async () => {
    const { service } = buildService({ load: null });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        1,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for a sequence that does not exist on this Load', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'BOOKED' }, stops: [] });

    await expect(
      service.rescheduleStop(
        ORG_ID,
        LOAD_ID,
        1,
        { appointmentDatetime: '2026-01-02T10:00:00Z' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('DispatchTrackingService.logCheckCall — Workflow 6 §6.7', () => {
  const CHECK_CALL_DTO = {
    contactMethod: 'Phone',
    personContacted: 'Driver',
    locationCity: 'Tulsa',
    locationState: 'OK',
    onTimeStatus: 'ON_TIME' as const,
  };

  it('creates a Check Call and updates the Load current location once Dispatched', async () => {
    const { service, audit } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' } });

    const { checkCall, load } = await service.logCheckCall(
      ORG_ID,
      LOAD_ID,
      CHECK_CALL_DTO,
      USER_ID,
    );

    expect(checkCall.onTimeStatus).toBe('ON_TIME');
    expect(load.currentLocationCity).toBe('Tulsa');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Check Call Logged' }),
    );
  });

  it('blocks a Check Call before the Load has been Dispatched', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'RATE_CONFIRMATION' } });

    await expect(service.logCheckCall(ORG_ID, LOAD_ID, CHECK_CALL_DTO, USER_ID)).rejects.toThrow(
      BusinessRuleError,
    );
  });
});

describe('DispatchTrackingService.setRiskStatus — Workflow 6 §6.8', () => {
  it('requires a reason when status is not Normal', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' } });

    await expect(
      service.setRiskStatus(ORG_ID, LOAD_ID, { riskStatus: 'AT_RISK' }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('sets risk status independent of Load.status, and audits it', async () => {
    const { service, audit } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' } });

    const load = await service.setRiskStatus(
      ORG_ID,
      LOAD_ID,
      { riskStatus: 'DELAYED', riskReason: 'Traffic' },
      USER_ID,
    );

    expect(load.riskStatus).toBe('DELAYED');
    expect(load.riskReason).toBe('Traffic');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Risk Status Changed' }),
    );
  });

  it('blocks Risk Status changes before the Load has been Dispatched', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'RATE_CONFIRMATION' } });

    await expect(
      service.setRiskStatus(ORG_ID, LOAD_ID, { riskStatus: 'NORMAL' }, USER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('DispatchTrackingService.assignDispatcher — independent action (approved decision)', () => {
  it('audits "Dispatcher Assigned" on the first assignment', async () => {
    const { service, audit } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED', assignedDispatcherId: null },
    });

    const load = await service.assignDispatcher(
      ORG_ID,
      LOAD_ID,
      { dispatcherUserId: 'dispatcher-1' },
      USER_ID,
    );

    expect(load.assignedDispatcherId).toBe('dispatcher-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Dispatcher Assigned' }),
    );
  });

  it('audits "Dispatcher Reassigned" when a different dispatcher replaces an existing one', async () => {
    const { service, audit } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED', assignedDispatcherId: 'dispatcher-1' },
    });

    await service.assignDispatcher(ORG_ID, LOAD_ID, { dispatcherUserId: 'dispatcher-2' }, USER_ID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Dispatcher Reassigned' }),
    );
  });

  it('is a no-op with no audit event when the same dispatcher is submitted again', async () => {
    const { service, audit } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED', assignedDispatcherId: 'dispatcher-1' },
    });

    await service.assignDispatcher(ORG_ID, LOAD_ID, { dispatcherUserId: 'dispatcher-1' }, USER_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is never gated by Load.status — works even on a BOOKED load', async () => {
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED', assignedDispatcherId: null },
    });

    await expect(
      service.assignDispatcher(ORG_ID, LOAD_ID, { dispatcherUserId: 'dispatcher-1' }, USER_ID),
    ).resolves.toBeDefined();
  });

  it('rejects assigning a user who is not an active member of the organization', async () => {
    const { service } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED', assignedDispatcherId: null },
      membership: null,
    });

    await expect(
      service.assignDispatcher(ORG_ID, LOAD_ID, { dispatcherUserId: 'not-a-member' }, USER_ID),
    ).rejects.toThrow(NotFoundError);
  });
});
