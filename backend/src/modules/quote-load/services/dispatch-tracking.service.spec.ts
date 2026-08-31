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

  // Timezone-fix regression (see business-timezone.ts) — actualArrival/
  // actualDeparture were investigated and found to have NO write-side
  // naive-datetime bug, because the frontend never actually sends a
  // `timestamp` (both call sites omit the body entirely), so this
  // `dto.timestamp ? ... : new Date()` branch always takes the `new
  // Date()` (no-args, always-correct "now") path in practice. That
  // behavior is deliberately left untouched by the timezone fix — these
  // two tests prove it stays that way.
  it('defaults actualArrival to "now" (an unambiguous absolute instant) when no timestamp is given — unchanged by the timezone fix', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' }];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    const before = Date.now();
    const { stop } = await service.recordArrival(ORG_ID, LOAD_ID, 1, {}, USER_ID);
    const after = Date.now();

    const arrivalMs = (stop.actualArrival as Date).getTime();
    expect(arrivalMs).toBeGreaterThanOrEqual(before);
    expect(arrivalMs).toBeLessThanOrEqual(after);
  });

  it('defaults actualDeparture to "now" when no timestamp is given — unchanged by the timezone fix', async () => {
    const stops = [
      {
        id: 'stop-1',
        sequence: 1,
        stopType: 'PICKUP',
        status: 'ARRIVED',
        actualArrival: new Date('2020-01-01T00:00:00Z'),
      },
    ];
    const { service } = buildService({ load: { id: LOAD_ID, status: 'DISPATCHED' }, stops });

    const before = Date.now();
    const { stop } = await service.recordDeparture(ORG_ID, LOAD_ID, 1, {}, USER_ID);
    const after = Date.now();

    const departureMs = (stop.actualDeparture as Date).getTime();
    expect(departureMs).toBeGreaterThanOrEqual(before);
    expect(departureMs).toBeLessThanOrEqual(after);
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

  it('interprets a naive datetime-local value (no timezone marker) as America/New_York wall-clock, not server-local time', async () => {
    const stops = [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'PENDING' }];
    const { service, tx } = buildService({ load: { id: LOAD_ID, status: 'BOOKED' }, stops });

    // 2:30 PM Eastern in EDT (summer) must become 18:30 UTC — never the
    // server process's own local timezone.
    await service.rescheduleStop(
      ORG_ID,
      LOAD_ID,
      1,
      { appointmentDatetime: '2026-09-01T14:30' },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith({
      where: { id: 'stop-1' },
      data: { appointmentDatetime: new Date('2026-09-01T18:30:00.000Z') },
    });
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

describe('DispatchTrackingService.updateStops — Load Detail Edit Stops action', () => {
  const EXISTING_STOP_1 = {
    id: 'stop-1',
    sequence: 1,
    stopType: 'PICKUP',
    status: 'PENDING',
    companyName: 'Old Pickup Co',
    addressLine1: '1 Old Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    appointmentDatetime: new Date('2026-01-01T10:00:00Z'),
    contactName: 'Old Contact',
    contactPhone: '555-0001',
    notes: 'Old note',
  };
  const EXISTING_STOP_2 = {
    id: 'stop-2',
    sequence: 2,
    stopType: 'DELIVERY',
    status: 'PENDING',
    companyName: 'Old Delivery Co',
    addressLine1: '2 Old Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
    appointmentDatetime: null,
    contactName: null,
    contactPhone: null,
    notes: null,
  };

  const UPDATED_STOP_1_ITEM = {
    sequence: 1,
    stopType: 'PICKUP' as const,
    companyName: 'ABC Manufacturing',
    addressLine1: '123 Main St',
    city: 'Philadelphia',
    state: 'PA',
    zip: '19101',
    appointmentDatetime: '2026-02-01T10:00:00Z',
    contactName: 'New Contact',
    contactPhone: '555-9999',
    notes: 'New note',
  };

  it('updates every field of a single stop and audits the previous/new values', async () => {
    const { service, tx, audit } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1],
    });

    const result = await service.updateStops(
      ORG_ID,
      LOAD_ID,
      { stops: [UPDATED_STOP_1_ITEM] },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith({
      where: { id: 'stop-1' },
      data: {
        stopType: 'PICKUP',
        companyName: 'ABC Manufacturing',
        addressLine1: '123 Main St',
        city: 'Philadelphia',
        state: 'PA',
        zip: '19101',
        appointmentDatetime: new Date('2026-02-01T10:00:00Z'),
        contactName: 'New Contact',
        contactPhone: '555-9999',
        notes: 'New note',
      },
    });
    expect(result.stops[0].companyName).toBe('ABC Manufacturing');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Stop Details Updated',
        entityType: 'Stop',
        entityId: 'stop-1',
      }),
    );
  });

  it("Edit Stops: interprets a naive datetime-local appointment (e.g. '2:30 PM' typed by a dispatcher) as America/New_York, not server-local time — the bug under investigation", async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1],
    });

    await service.updateStops(
      ORG_ID,
      LOAD_ID,
      { stops: [{ ...UPDATED_STOP_1_ITEM, appointmentDatetime: '2026-09-01T14:30' }] },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appointmentDatetime: new Date('2026-09-01T18:30:00.000Z'),
        }),
      }),
    );
  });

  it('Edit -> save -> reload regression: the same Eastern wall-clock value round-trips through storage unchanged', async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1],
    });

    // "Save": a dispatcher enters 2:30 PM Eastern.
    await service.updateStops(
      ORG_ID,
      LOAD_ID,
      { stops: [{ ...UPDATED_STOP_1_ITEM, appointmentDatetime: '2026-09-01T14:30' }] },
      USER_ID,
    );
    const storedUtcInstant = (tx.stop.update as jest.Mock).mock.calls[0][0].data
      .appointmentDatetime as Date;

    // "Reload": the frontend's toBusinessDatetimeLocalValue (tested in
    // businessTimezone.test.ts) converts the stored UTC instant back to
    // Eastern wall-clock for display/re-edit. Reproduced here with the
    // identical Intl-based technique to assert the round trip end to end.
    const displayed = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(storedUtcInstant)
      .reduce<Record<string, string>>((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});

    expect(
      `${displayed.year}-${displayed.month}-${displayed.day}T${displayed.hour}:${displayed.minute}`,
    ).toBe('2026-09-01T14:30');
  });

  it('writes companyName directly from the submitted value — never derives it from Load/Customer/CustomerLocation', async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED', customerId: 'customer-999' },
      stops: [EXISTING_STOP_1],
    });

    await service.updateStops(
      ORG_ID,
      LOAD_ID,
      { stops: [{ ...UPDATED_STOP_1_ITEM, companyName: 'XYZ Distribution' }] },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ companyName: 'XYZ Distribution' }),
      }),
    );
    // The mocked tx has no `customer`/`customerLocation` table at all —
    // if the service tried to look either up to derive companyName, this
    // test would throw on that call instead of reaching the assertion
    // above, since neither is defined on the buildService() tx mock.
  });

  it('updates multiple stops in one call, each independently audited', async () => {
    const { service, tx, audit } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1, EXISTING_STOP_2],
    });

    const result = await service.updateStops(
      ORG_ID,
      LOAD_ID,
      {
        stops: [
          UPDATED_STOP_1_ITEM,
          {
            sequence: 2,
            stopType: 'DELIVERY',
            companyName: 'DEF Distribution',
            addressLine1: '456 Industrial Ave',
            city: 'Lodi',
            state: 'NJ',
            zip: '07644',
          },
        ],
      },
      USER_ID,
    );

    expect(result.stops).toHaveLength(2);
    expect(result.stops[0].companyName).toBe('ABC Manufacturing');
    expect(result.stops[1].companyName).toBe('DEF Distribution');
    expect(tx.stop.update).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('clears an optional field left empty — full-replace semantics, not partial-patch', async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1],
    });

    await service.updateStops(
      ORG_ID,
      LOAD_ID,
      {
        stops: [
          {
            ...UPDATED_STOP_1_ITEM,
            appointmentDatetime: undefined,
            contactName: undefined,
            contactPhone: undefined,
            notes: undefined,
          },
        ],
      },
      USER_ID,
    );

    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          appointmentDatetime: null,
          contactName: null,
          contactPhone: null,
          notes: null,
        }),
      }),
    );
  });

  it('never touches Stop.status/actualArrival/actualDeparture', async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'DISPATCHED' },
      stops: [
        { ...EXISTING_STOP_1, status: 'ARRIVED', actualArrival: new Date('2026-01-01T12:00:00Z') },
      ],
    });

    await service.updateStops(ORG_ID, LOAD_ID, { stops: [UPDATED_STOP_1_ITEM] }, USER_ID);

    const data = tx.stop.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('actualArrival');
    expect(data).not.toHaveProperty('actualDeparture');
  });

  it('throws NotFoundError for a Load outside the organization', async () => {
    const { service } = buildService({ load: null });

    await expect(
      service.updateStops(ORG_ID, LOAD_ID, { stops: [UPDATED_STOP_1_ITEM] }, USER_ID),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for a sequence that does not exist on this Load, without updating any stop', async () => {
    const { service, tx } = buildService({
      load: { id: LOAD_ID, status: 'BOOKED' },
      stops: [EXISTING_STOP_1],
    });

    await expect(
      service.updateStops(
        ORG_ID,
        LOAD_ID,
        { stops: [{ ...UPDATED_STOP_1_ITEM, sequence: 99 }] },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(tx.stop.update).not.toHaveBeenCalled();
  });

  it('scopes every lookup by loadId + organizationId + sequence — a matching sequence on another load is never touched', async () => {
    // Purpose-built tx mock (not the shared buildService fixture): two
    // "loads" each with their own sequence-1 stop, proving the lookup
    // is loadId-scoped, not sequence-only.
    const otherLoadStop = { id: 'other-load-stop-1', sequence: 1, companyName: 'Other Load Co' };
    const thisLoadStop = { ...EXISTING_STOP_1 };

    const findFirstCalls: unknown[] = [];
    const tx = {
      load: { findFirst: jest.fn().mockResolvedValue({ id: LOAD_ID, status: 'BOOKED' }) },
      stop: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          findFirstCalls.push(where);
          if (where.loadId === LOAD_ID && where.sequence === 1) return thisLoadStop;
          return null;
        }),
        findMany: jest.fn().mockResolvedValue([thisLoadStop]),
        update: jest
          .fn()
          .mockImplementation(({ where, data }) => ({ ...thisLoadStop, ...data, id: where.id })),
      },
    };
    const prisma = {
      withTenantTransaction: jest.fn().mockImplementation((_orgId, fn) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new DispatchTrackingService(
      prisma as never,
      audit as never,
      {} as never,
      new LoadStatusDerivationService(),
    );

    const result = await service.updateStops(
      ORG_ID,
      LOAD_ID,
      { stops: [UPDATED_STOP_1_ITEM] },
      USER_ID,
    );

    expect(findFirstCalls).toContainEqual({ loadId: LOAD_ID, organizationId: ORG_ID, sequence: 1 });
    expect(tx.stop.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: thisLoadStop.id } }),
    );
    expect(result.stops[0].companyName).toBe('ABC Manufacturing');
    // The other load's row was never even a candidate — findFirst was
    // scoped to LOAD_ID from the start, so `otherLoadStop` (id
    // 'other-load-stop-1') never appears in any tx.stop.update call.
    expect(tx.stop.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: otherLoadStop.id } }),
    );
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

  // Timezone-fix regression — CheckCall.occurredAt/eta and Load.currentEta
  // are populated from real datetime-local inputs (StopsTrackingTab's
  // "Log Check Call" modal) and were confirmed to have the same live
  // naive-datetime bug as appointmentDatetime.
  it('interprets a naive occurredAt/eta as America/New_York wall-clock, not server-local time', async () => {
    const { service, tx } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' } });

    const { checkCall, load } = await service.logCheckCall(
      ORG_ID,
      LOAD_ID,
      { ...CHECK_CALL_DTO, occurredAt: '2026-09-01T14:30', eta: '2026-09-01T16:00' },
      USER_ID,
    );

    expect(checkCall.occurredAt).toEqual(new Date('2026-09-01T18:30:00.000Z'));
    expect(checkCall.eta).toEqual(new Date('2026-09-01T20:00:00.000Z'));
    expect(load.currentEta).toEqual(new Date('2026-09-01T20:00:00.000Z'));
    expect(tx.checkCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          occurredAt: new Date('2026-09-01T18:30:00.000Z'),
          eta: new Date('2026-09-01T20:00:00.000Z'),
        }),
      }),
    );
  });

  it('still defaults occurredAt to "now" when omitted (unchanged behavior)', async () => {
    const { service } = buildService({ load: { id: LOAD_ID, status: 'IN_TRANSIT' } });

    const before = Date.now();
    const { checkCall } = await service.logCheckCall(ORG_ID, LOAD_ID, CHECK_CALL_DTO, USER_ID);
    const after = Date.now();

    const occurredAtMs = (checkCall.occurredAt as Date).getTime();
    expect(occurredAtMs).toBeGreaterThanOrEqual(before);
    expect(occurredAtMs).toBeLessThanOrEqual(after);
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
