import { Prisma } from '@prisma/client';
import { LoadService } from './load.service';
import {
  BusinessRuleError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../common/errors/app-error';

const ORG_ID = 'org-1';
const CUSTOMER_ID = 'customer-1';
const USER_ID = 'user-1';

const BASE_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    companyName: 'ABC Manufacturing',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    companyName: 'XYZ Distribution',
    addressLine1: '2 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
];

function buildService(opts: {
  customer?: { id: string; status: string } | null;
  rateMatch?: { rateAgreementId: string | null; rateSource: string } | null;
  loads?: Record<string, unknown>[];
}) {
  const customerLookupResult =
    'customer' in opts ? opts.customer : { id: CUSTOMER_ID, status: 'ACTIVE' };
  const tx = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(customerLookupResult),
    },
    load: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue(opts.loads ?? []),
      create: jest.fn().mockImplementation(({ data }) => ({
        ...data,
        id: 'load-1',
        customerRate: new Prisma.Decimal(data.customerRate),
        stops: data.stops.create,
      })),
      update: jest
        .fn()
        .mockImplementation(({ data }) => ({ id: 'load-1', status: 'BOOKED', ...data })),
    },
    document: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chargeTypeDefinition: {
      findFirst: jest.fn().mockResolvedValue({ id: 'linehaul-type-1', code: 'LINEHAUL' }),
    },
    chargeLineItem: {
      create: jest.fn().mockImplementation(({ data }) => ({ id: 'charge-1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    invoiceLoad: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    carrierPayment: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const sequences = {
    getNextNumber: jest.fn().mockResolvedValue(456n),
    format: jest.fn().mockReturnValue('LOAD-000456'),
  };
  const rateAgreementMatching = {
    resolveRate: jest
      .fn()
      .mockResolvedValue(opts.rateMatch ?? { rateAgreementId: null, rateSource: 'MANUAL' }),
  };

  const service = new LoadService(
    prisma as never,
    audit as never,
    sequences as never,
    rateAgreementMatching as never,
  );

  return { service, tx, audit, sequences, rateAgreementMatching };
}

describe('LoadService.list — Frontend Phase 3 gap-fix (Dispatch Board Table View)', () => {
  it('includes stops and dispatchRecord.sourceDriver on every row (Origin/Destination + Pickup/Delivery Date + Driver columns need them)', async () => {
    const { service, tx } = buildService({});

    await service.list(ORG_ID, USER_ID, ['ADMIN']);

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          stops: true,
          dispatchRecord: {
            include: { sourceDriver: { select: { firstName: true, lastName: true } } },
          },
        },
      }),
    );
  });

  it('narrows the sourceDriver relation to a select of only firstName/lastName — never the full Driver row', async () => {
    const { service, tx } = buildService({});

    await service.list(ORG_ID, USER_ID, ['ADMIN']);

    const call = tx.load.findMany.mock.calls[0][0];
    expect(call.include.dispatchRecord.include.sourceDriver).toEqual({
      select: { firstName: true, lastName: true },
    });
    // Explicitly not a bare `true` (which would fetch every Driver column
    // — phone/email/licenseNumber/notes/organizationId/carrierId).
    expect(call.include.dispatchRecord.include.sourceDriver).not.toBe(true);
  });

  it('applies carrierId, dispatcherId, and equipmentType filters when provided, alongside the existing status/customerId ones', async () => {
    const { service, tx } = buildService({});

    await service.list(ORG_ID, USER_ID, ['ADMIN'], {
      status: 'DISPATCHED',
      customerId: CUSTOMER_ID,
      carrierId: 'carrier-1',
      dispatcherId: 'dispatcher-1',
      equipmentType: 'DRY_VAN',
    });

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'DISPATCHED',
          customerId: CUSTOMER_ID,
          assignedCarrierId: 'carrier-1',
          assignedDispatcherId: 'dispatcher-1',
          equipmentType: 'DRY_VAN',
        }),
      }),
    );
  });

  it('omits the new filters entirely when not provided — no behavior change for existing callers', async () => {
    const { service, tx } = buildService({});

    await service.list(ORG_ID, USER_ID, ['ADMIN'], { status: 'BOOKED' });

    const call = tx.load.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('assignedCarrierId');
    expect(call.where).not.toHaveProperty('assignedDispatcherId');
    expect(call.where).not.toHaveProperty('equipmentType');
  });
});

describe('LoadService.list — Dispatch Board Driver visibility', () => {
  const BASE_LOAD_ROW = {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    stops: [],
  };

  it('resolves assignedDriverName from the live sourceDriver record when the dispatch is linked to one (never the stale snapshot)', async () => {
    const { service, tx } = buildService({
      loads: [
        {
          ...BASE_LOAD_ROW,
          dispatchRecord: {
            driverName: 'Old Snapshotted Name', // must NOT win when sourceDriver is present
            sourceDriverId: 'driver-1',
            sourceDriver: { id: 'driver-1', firstName: 'Julia', lastName: 'Ramos' },
          },
        },
      ],
    });

    const [load] = await service.list(ORG_ID, USER_ID, ['ADMIN']);

    expect((load as { assignedDriverName: string | null }).assignedDriverName).toBe('Julia Ramos');
    expect(tx.load.findMany).toHaveBeenCalled();
  });

  it('falls back to the DispatchRecord’s own snapshotted driverName for a manually-typed dispatch (no linked Driver record)', async () => {
    const { service } = buildService({
      loads: [
        {
          ...BASE_LOAD_ROW,
          dispatchRecord: {
            driverName: 'Manually Typed Driver',
            sourceDriverId: null,
            sourceDriver: null,
          },
        },
      ],
    });

    const [load] = await service.list(ORG_ID, USER_ID, ['ADMIN']);

    expect((load as { assignedDriverName: string | null }).assignedDriverName).toBe(
      'Manually Typed Driver',
    );
  });

  it('assignedDriverName is null when the Load has never been dispatched', async () => {
    const { service } = buildService({
      loads: [{ ...BASE_LOAD_ROW, dispatchRecord: null }],
    });

    const [load] = await service.list(ORG_ID, USER_ID, ['ADMIN']);

    expect((load as { assignedDriverName: string | null }).assignedDriverName).toBeNull();
  });

  it('never exposes the raw dispatchRecord/sourceDriver objects in the response — only the resolved assignedDriverName string', async () => {
    const { service } = buildService({
      loads: [
        {
          ...BASE_LOAD_ROW,
          dispatchRecord: {
            driverName: 'Julia Ramos',
            sourceDriverId: 'driver-1',
            sourceDriver: {
              id: 'driver-1',
              firstName: 'Julia',
              lastName: 'Ramos',
              phone: '555-0000',
              licenseNumber: 'DL123',
            },
          },
        },
      ],
    });

    const [load] = await service.list(ORG_ID, USER_ID, ['ADMIN']);

    expect(load).not.toHaveProperty('dispatchRecord');
    expect((load as { assignedDriverName: string | null }).assignedDriverName).toBe('Julia Ramos');
  });

  it('resolves every row within the same organization-scoped transaction as the rest of the query — never a second, unscoped read', async () => {
    const { service, tx } = buildService({
      loads: [
        {
          ...BASE_LOAD_ROW,
          id: 'load-1',
          dispatchRecord: {
            driverName: 'Julia Ramos',
            sourceDriverId: 'driver-1',
            sourceDriver: { id: 'driver-1', firstName: 'Julia', lastName: 'Ramos' },
          },
        },
        {
          ...BASE_LOAD_ROW,
          id: 'load-2',
          loadNumber: 'LOAD-000002',
          dispatchRecord: null,
        },
      ],
    });

    const loads = await service.list(ORG_ID, USER_ID, ['ADMIN']);

    // Both rows resolved from the single findMany call's own include —
    // no per-row driver lookup, so no possibility of a cross-tenant leak
    // via an unscoped follow-up query.
    expect(tx.load.findMany).toHaveBeenCalledTimes(1);
    expect(
      loads.map((l) => (l as { assignedDriverName: string | null }).assignedDriverName),
    ).toEqual(['Julia Ramos', null]);
  });
});

describe('LoadService.createDirect — Workflow 4 §4.8', () => {
  it('creates a Load at status BOOKED with bookingSource=DIRECT, quoteId=NULL, dispatcherId=NULL', async () => {
    const { service, sequences, audit } = buildService({});

    const load = await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      },
      USER_ID,
    );

    expect(load.status).toBe('BOOKED');
    expect(load.loadNumber).toBe('LOAD-000456');
    expect(load.bookingSource).toBe('DIRECT');
    expect(load.quoteId).toBeNull();
    expect(load.assignedDispatcherId).toBeUndefined();
    expect(sequences.getNextNumber).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'LOAD');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Load Booked Directly (No Quote)' }),
    );
    // createFromBooking's declared return type is the bare Load (no stops
    // relation), even though `include: { stops: true }` puts it on the
    // runtime object — same cast style as the `as never` params above.
    expect((load as never as { stops: unknown }).stops).toEqual([
      expect.objectContaining({ companyName: 'ABC Manufacturing' }),
      expect.objectContaining({ companyName: 'XYZ Distribution' }),
    ]);
  });

  it('Timezone fix: interprets a naive stop appointmentDatetime (New Load form datetime-local) as America/New_York, not server-local time', async () => {
    const { service, tx } = buildService({});

    await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: [
          { ...BASE_STOPS[0], appointmentDatetime: '2026-09-01T14:30' },
          BASE_STOPS[1],
        ] as never,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      },
      USER_ID,
    );

    expect(tx.load.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stops: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({
                sequence: 1,
                appointmentDatetime: new Date('2026-09-01T18:30:00.000Z'),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('Phase 6: creates an ORIGINAL customer-side LINEHAUL ChargeLineItem at booking time (DATABASE_DESIGN.md §14)', async () => {
    const { service, tx } = buildService({});

    await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      },
      USER_ID,
    );

    expect(tx.chargeTypeDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ code: 'LINEHAUL' }) }),
    );
    expect(tx.chargeLineItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loadId: 'load-1',
          side: 'CUSTOMER',
          chargeTypeId: 'linehaul-type-1',
          unitRate: new Prisma.Decimal('1800.00'),
          amount: new Prisma.Decimal('1800.00'),
          source: 'ORIGINAL',
          createdByUserId: USER_ID,
        }),
      }),
    );
  });

  it('rejects booking when Customer is Prospect', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'PROSPECT' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects booking when Customer is Blocked, with no override possible', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'BLOCKED' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
          confirmInactiveCustomerOverride: true,
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects booking when Customer is Inactive without an explicit override confirmation', async () => {
    const { service } = buildService({ customer: { id: CUSTOMER_ID, status: 'INACTIVE' } });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('allows booking when Customer is Inactive with an explicit override, and audits it', async () => {
    const { service, audit } = buildService({ customer: { id: CUSTOMER_ID, status: 'INACTIVE' } });

    const load = await service.createDirect(
      ORG_ID,
      {
        customerId: CUSTOMER_ID,
        stops: BASE_STOPS as never,
        equipmentType: 'DRY_VAN',
        customerRate: '100.00',
        confirmInactiveCustomerOverride: true,
      },
      USER_ID,
    );

    expect(load.status).toBe('BOOKED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Inactive Customer Booking Override' }),
    );
  });

  it('rejects creation when Customer does not exist in this org', async () => {
    const { service } = buildService({ customer: null });

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: BASE_STOPS as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects creation with no pickup or no delivery stop', async () => {
    const { service } = buildService({});

    await expect(
      service.createDirect(
        ORG_ID,
        {
          customerId: CUSTOMER_ID,
          stops: [BASE_STOPS[0]] as never,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        },
        USER_ID,
      ),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('LoadService.updateReferenceNumbers — Workflow 4 §4.10', () => {
  it('updates reference numbers and audits the field-level diff', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', customerPoNumber: null, bolNumber: null });

    const updated = await service.updateReferenceNumbers(
      ORG_ID,
      'load-1',
      { customerPoNumber: 'PO-123' },
      USER_ID,
    );

    expect(updated.customerPoNumber).toBe('PO-123');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Reference Number Added/Updated' }),
    );
  });

  it('does not audit when nothing actually changed', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', customerPoNumber: 'PO-123' });

    await service.updateReferenceNumbers(ORG_ID, 'load-1', { customerPoNumber: 'PO-123' }, USER_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(
      service.updateReferenceNumbers(
        ORG_ID,
        'nonexistent',
        { customerPoNumber: 'PO-123' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('LoadService.addCharge — Decision Log D9', () => {
  it('adds a source=ADJUSTMENT charge, computing amount = quantity * unitRate', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', status: 'DELIVERED' });

    const charge = await service.addCharge(
      ORG_ID,
      'load-1',
      { side: 'CUSTOMER', chargeTypeId: 'detention-type-1', quantity: '2', unitRate: '75.00' },
      USER_ID,
    );

    expect(tx.chargeLineItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          loadId: 'load-1',
          side: 'CUSTOMER',
          chargeTypeId: 'detention-type-1',
          quantity: '2',
          unitRate: '75.00',
          amount: '150.00',
          source: 'ADJUSTMENT',
          createdByUserId: USER_ID,
        }),
      }),
    );
    expect(charge).toBeDefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Charge Line Item Added' }),
    );
  });

  it('defaults quantity to 1 when omitted', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', status: 'DELIVERED' });

    await service.addCharge(
      ORG_ID,
      'load-1',
      { side: 'CARRIER', chargeTypeId: 'lumper-type-1', unitRate: '50.00' },
      USER_ID,
    );

    expect(tx.chargeLineItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantity: '1', amount: '50.00' }),
      }),
    );
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(
      service.addCharge(
        ORG_ID,
        'nonexistent',
        { side: 'CUSTOMER', chargeTypeId: 'detention-type-1', unitRate: '75.00' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for a nonexistent charge type', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', status: 'DELIVERED' });
    tx.chargeTypeDefinition.findFirst.mockResolvedValue(null);

    await expect(
      service.addCharge(
        ORG_ID,
        'load-1',
        { side: 'CUSTOMER', chargeTypeId: 'nonexistent-type', unitRate: '75.00' },
        USER_ID,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('LoadService.closeLoad — Workflow 10', () => {
  it('closes unconditionally even with every checklist item at Warning, and snapshots it', async () => {
    const { service, tx, audit } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'NOT_RECEIVED',
      carrierRate: null,
    });

    const result = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    expect(result.load.status).toBe('CLOSED');
    expect(result.checklistSnapshot).toEqual([
      { item: 'Rate Confirmation', status: 'WARNING', detail: 'Missing' },
      { item: 'POD', status: 'WARNING', detail: 'Not Received' },
      { item: 'Customer Invoice', status: 'WARNING', detail: 'Missing' },
      { item: 'Carrier Pay', status: 'WARNING', detail: 'No payment recorded' },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Load Closed',
        newValue: { checklistSnapshot: result.checklistSnapshot },
      }),
    );
  });

  it('reports every item Clean when Rate Confirmation/POD/Invoice/Carrier Pay are all present', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    });
    tx.document.findFirst.mockResolvedValue({ id: 'doc-1' });
    tx.invoiceLoad.findFirst.mockResolvedValue({ id: 'invoice-load-1' });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: new Prisma.Decimal('1500.00') },
    ]);

    const { checklistSnapshot } = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    expect(checklistSnapshot.every((c) => c.status === 'CLEAN')).toBe(true);
  });

  it('surfaces remainingCarrierBalance on an otherwise-Clean Carrier Pay item when a balance remains', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: new Prisma.Decimal('500.00') },
    ]);

    const { checklistSnapshot } = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    const carrierPayItem = checklistSnapshot.find((c) => c.item === 'Carrier Pay');
    expect(carrierPayItem?.status).toBe('CLEAN');
    expect(carrierPayItem?.remainingCarrierBalance).toBe('1000.00');
  });

  it('Accessorial Charges regression — a Load with zero carrier accessorials produces the exact same remainingCarrierBalance as before this feature existed', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: new Prisma.Decimal('500.00') },
    ]);
    tx.chargeLineItem.findMany.mockResolvedValue([]);

    const { checklistSnapshot } = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    const carrierPayItem = checklistSnapshot.find((c) => c.item === 'Carrier Pay');
    expect(carrierPayItem?.remainingCarrierBalance).toBe('1000.00');
  });

  it('folds carrier-side ADJUSTMENT (accessorial) charges into remainingCarrierBalance, on top of carrierRate', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: new Prisma.Decimal('500.00') },
    ]);
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: new Prisma.Decimal('200.00') },
    ]);

    const { checklistSnapshot } = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    const carrierPayItem = checklistSnapshot.find((c) => c.item === 'Carrier Pay');
    expect(carrierPayItem?.remainingCarrierBalance).toBe('1200.00');
    expect(tx.chargeLineItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          loadId: 'load-1',
          side: 'CARRIER',
          source: 'ADJUSTMENT',
        }),
      }),
    );
  });

  it('never counts a CUSTOMER-side charge toward remainingCarrierBalance', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    });
    // A non-empty (but non-PAID, so $0 toward totalPaid) CarrierPayment
    // array — remainingCarrierBalance is only surfaced on the checklist
    // once at least one CarrierPayment record exists (pre-existing gate,
    // unrelated to this feature); an empty array would make this
    // assertion vacuously fail regardless of the accessorial-summing
    // logic actually under test here.
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'DRAFT', amount: new Prisma.Decimal('100.00') },
    ]);
    // The mock's own `where` filter isn't enforced by jest — assert the
    // service only sums what the query (correctly scoped to
    // side='CARRIER') would ever return, not a mixed-side result.
    tx.chargeLineItem.findMany.mockResolvedValue([
      { side: 'CARRIER', source: 'ADJUSTMENT', amount: new Prisma.Decimal('200.00') },
    ]);

    const { checklistSnapshot } = await service.closeLoad(ORG_ID, 'load-1', USER_ID);

    const carrierPayItem = checklistSnapshot.find((c) => c.item === 'Carrier Pay');
    expect(carrierPayItem?.remainingCarrierBalance).toBe('1700.00');
  });

  it('rejects closing an already-Closed Load — the only precondition (Workflow 10 §10.9)', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', status: 'CLOSED' });

    await expect(service.closeLoad(ORG_ID, 'load-1', USER_ID)).rejects.toThrow(/already Closed/);
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(service.closeLoad(ORG_ID, 'nonexistent', USER_ID)).rejects.toThrow(NotFoundError);
  });
});

describe('LoadService.cancelLoad — Cancel Load workflow', () => {
  const CANCEL_DTO = { reason: 'Customer cancelled the order.' };

  // 1-4: cancellation succeeds from each of the four pre-dispatch statuses.
  it.each(['BOOKED', 'CARRIER_SOURCING', 'CARRIER_ASSIGNED', 'RATE_CONFIRMATION'] as const)(
    'cancels a Load from %s, setting status/cancelledAt/cancelledByUserId and recording the audit entry',
    async (status) => {
      const { service, tx, audit } = buildService({});
      tx.load.findFirst.mockResolvedValue({ id: 'load-1', status });

      const result = await service.cancelLoad(ORG_ID, 'load-1', CANCEL_DTO, USER_ID);

      expect(result.status).toBe('CANCELLED');
      expect(result.cancelledAt).toBeInstanceOf(Date);
      expect(result.cancelledByUserId).toBe(USER_ID);
      expect(tx.load.update).toHaveBeenCalledWith({
        where: { id: 'load-1' },
        data: {
          status: 'CANCELLED',
          cancelledAt: expect.any(Date),
          cancelledByUserId: USER_ID,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'Load Cancelled',
          entityType: 'Load',
          entityId: 'load-1',
          reason: CANCEL_DTO.reason,
          previousValue: { status },
          newValue: { status: 'CANCELLED', reason: CANCEL_DTO.reason },
          actorUserId: USER_ID,
        }),
      );
    },
  );

  // 5-10: cancellation is rejected — a clean InvalidTransitionError, never
  // a raw crash — from every status that isn't pre-dispatch, including an
  // already-CANCELLED Load (idempotency: the second cancel attempt fails
  // cleanly and writes no second audit entry, since it never reaches
  // `tx.load.update`/`audit.record` at all).
  it.each(['DISPATCHED', 'PICKUP', 'IN_TRANSIT', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const)(
    'rejects cancelling a Load that is already %s',
    async (status) => {
      const { service, tx, audit } = buildService({});
      tx.load.findFirst.mockResolvedValue({ id: 'load-1', status });

      await expect(service.cancelLoad(ORG_ID, 'load-1', CANCEL_DTO, USER_ID)).rejects.toThrow(
        InvalidTransitionError,
      );
      expect(tx.load.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(service.cancelLoad(ORG_ID, 'nonexistent', CANCEL_DTO, USER_ID)).rejects.toThrow(
      NotFoundError,
    );
  });

  // Cross-tenant isolation — a Load id that doesn't belong to the acting
  // organization resolves to nothing via the tenant-scoped `where`, so it's
  // indistinguishable from "not found" (never a raw cross-tenant leak).
  it('rejects cancelling a Load outside the acting organization (tenant isolation)', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(service.cancelLoad('org-OTHER', 'load-1', CANCEL_DTO, USER_ID)).rejects.toThrow(
      NotFoundError,
    );
  });

  // Preserves all operational/financial history: the only write is the
  // single `tx.load.update` call asserted above (status/cancelledAt/
  // cancelledByUserId, nothing else). This harness's `tx` mock has no
  // stop/checkCall/dispatchRecord/carrier/driver mutation methods defined
  // at all — if `cancelLoad` ever touched any of those tables, every test
  // in this block would fail with a runtime error, not silently pass.
  // `chargeLineItem` IS present on this harness (used by `addCharge`
  // elsewhere), so it gets an explicit assertion too.
  it('never creates a ChargeLineItem or touches any table beyond the Load row itself', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({ id: 'load-1', status: 'BOOKED' });

    await service.cancelLoad(ORG_ID, 'load-1', CANCEL_DTO, USER_ID);

    expect(tx.chargeLineItem.create).not.toHaveBeenCalled();
  });
});

describe('LoadService.getClosingChecklist — Frontend Phase 4 gap-fix', () => {
  it('returns the same checklist closeLoad would compute, without mutating the Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'NOT_RECEIVED',
      carrierRate: null,
    });

    const result = await service.getClosingChecklist(ORG_ID, 'load-1');

    expect(result).toEqual({
      checklist: [
        { item: 'Rate Confirmation', status: 'WARNING', detail: 'Missing' },
        { item: 'POD', status: 'WARNING', detail: 'Not Received' },
        { item: 'Customer Invoice', status: 'WARNING', detail: 'Missing' },
        { item: 'Carrier Pay', status: 'WARNING', detail: 'No payment recorded' },
      ],
    });
    expect(tx.load.update).not.toHaveBeenCalled();
  });

  it('reflects Clean items identically to closeLoad for the same Load state', async () => {
    const { service, tx } = buildService({});
    const loadRow = {
      id: 'load-1',
      status: 'DELIVERED',
      podStatus: 'COMPLETE',
      carrierRate: new Prisma.Decimal('1500.00'),
    };
    tx.load.findFirst.mockResolvedValue(loadRow);
    tx.document.findFirst.mockResolvedValue({ id: 'doc-1' });
    tx.invoiceLoad.findFirst.mockResolvedValue({ id: 'invoice-load-1' });
    tx.carrierPayment.findMany.mockResolvedValue([
      { status: 'PAID', amount: new Prisma.Decimal('1500.00') },
    ]);

    const { checklist } = await service.getClosingChecklist(ORG_ID, 'load-1');

    expect(checklist.every((c) => c.status === 'CLEAN')).toBe(true);
  });

  it('does not require the Load to be non-Closed — previewing an already-Closed Load is allowed', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      status: 'CLOSED',
      podStatus: 'COMPLETE',
      carrierRate: null,
    });

    await expect(service.getClosingChecklist(ORG_ID, 'load-1')).resolves.toBeDefined();
  });

  it('throws NotFoundError for a nonexistent Load', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue(null);

    await expect(service.getClosingChecklist(ORG_ID, 'nonexistent')).rejects.toThrow(NotFoundError);
  });
});

describe('LoadService.getReadyToInvoice — Workflow 8 §8.1', () => {
  it('queries Loads at DELIVERED/CLOSED with invoiced=false, optionally scoped to one customer', async () => {
    const { service, tx } = buildService({});

    await service.getReadyToInvoice(ORG_ID, CUSTOMER_ID, USER_ID, ['ACCOUNTING']);

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          status: { in: ['DELIVERED', 'CLOSED'] },
          invoiced: false,
          customerId: CUSTOMER_ID,
        }),
      }),
    );
  });

  it('computes customerChargesTotal from CUSTOMER-side charge line items only', async () => {
    const { service, tx } = buildService({});
    tx.load.findMany.mockResolvedValue([
      {
        id: 'load-1',
        createdByUserId: USER_ID,
        customerRate: new Prisma.Decimal('1800.00'),
        rateSource: 'MANUAL',
        rateAgreementId: null,
        chargeLineItems: [
          { side: 'CUSTOMER', amount: new Prisma.Decimal('1800.00') },
          { side: 'CUSTOMER', amount: new Prisma.Decimal('200.00') },
          { side: 'CARRIER', amount: new Prisma.Decimal('1500.00') },
        ],
      },
    ]);

    const [load] = await service.getReadyToInvoice(ORG_ID, undefined, USER_ID, ['ACCOUNTING']);

    expect(load.customerChargesTotal).toBe('2000.00');
  });
});

describe('LoadService — role-based financial field shaping (§7)', () => {
  it('strips $ fields for a Dispatcher-only viewer', async () => {
    const { service, tx } = buildService({});
    tx.load.findFirst.mockResolvedValue({
      id: 'load-1',
      createdByUserId: 'someone-else',
      customerRate: new Prisma.Decimal('100.00'),
      rateSource: 'MANUAL',
      rateAgreementId: null,
      stops: [],
    });

    const load = await service.findById(ORG_ID, 'load-1', USER_ID, ['DISPATCHER']);
    expect(load.customerRate).toBeNull();
  });
});
