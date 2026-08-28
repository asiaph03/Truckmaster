import { LoadSearchService } from './load-search.service';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function load(overrides: Record<string, unknown> = {}) {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000001',
    customerId: 'customer-1',
    status: 'BOOKED',
    equipmentType: 'DRY_VAN',
    riskStatus: 'NORMAL',
    customerRate: '1800.00',
    carrierRate: null,
    createdByUserId: USER_ID,
    stops: [],
    ...overrides,
  };
}

function buildService(opts: {
  loadFindMany?: jest.Mock;
  loadCount?: jest.Mock;
  stopFindMany?: jest.Mock;
}) {
  const tx = {
    load: {
      count: opts.loadCount ?? jest.fn().mockResolvedValue(0),
      findMany: opts.loadFindMany ?? jest.fn().mockResolvedValue([]),
    },
    stop: {
      findMany: opts.stopFindMany ?? jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const service = new LoadSearchService(prisma as never);
  return { service, tx };
}

describe('LoadSearchService.search — filter/where construction', () => {
  it('builds the flat filters exactly like LoadService.list, plus riskStatus (new to Load Search)', async () => {
    const { service, tx } = buildService({});

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      {
        status: 'DISPATCHED',
        customerId: 'customer-1',
        carrierId: 'carrier-1',
        dispatcherId: 'dispatcher-1',
        equipmentType: 'DRY_VAN',
        riskStatus: 'AT_RISK',
      },
      { page: 1, pageSize: 50 },
    );

    expect(tx.load.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: ORG_ID,
        status: 'DISPATCHED',
        customerId: 'customer-1',
        assignedCarrierId: 'carrier-1',
        assignedDispatcherId: 'dispatcher-1',
        equipmentType: 'DRY_VAN',
        riskStatus: 'AT_RISK',
      }),
    });
  });

  it('expresses a Pickup Date range as a stops-relation AND clause, independent of a Delivery Date range', async () => {
    const { service, tx } = buildService({});

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { pickupFrom: '2026-01-01', pickupTo: '2026-01-31', deliveryFrom: '2026-02-01' },
      { page: 1, pageSize: 50 },
    );

    const where = (tx.load.count as jest.Mock).mock.calls[0][0].where;
    expect(where.AND).toEqual([
      {
        stops: {
          some: {
            stopType: 'PICKUP',
            appointmentDatetime: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
          },
        },
      },
      {
        stops: {
          some: { stopType: 'DELIVERY', appointmentDatetime: { gte: new Date('2026-02-01') } },
        },
      },
    ]);
  });

  it('expands free-text search across Load #, Customer name, Carrier name, and Origin/Destination stop fields', async () => {
    const { service, tx } = buildService({});

    await service.search(ORG_ID, USER_ID, ['ADMIN'], { q: 'dallas' }, { page: 1, pageSize: 50 });

    const where = (tx.load.count as jest.Mock).mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { loadNumber: { contains: 'dallas', mode: 'insensitive' } },
      { customer: { legalName: { contains: 'dallas', mode: 'insensitive' } } },
      { assignedCarrier: { legalName: { contains: 'dallas', mode: 'insensitive' } } },
      {
        stops: {
          some: {
            OR: [
              { city: { contains: 'dallas', mode: 'insensitive' } },
              { state: { contains: 'dallas', mode: 'insensitive' } },
              { addressLine1: { contains: 'dallas', mode: 'insensitive' } },
            ],
          },
        },
      },
    ]);
  });
});

describe('LoadSearchService.search — sorting and pagination', () => {
  it('defaults to createdAt desc, DB-level orderBy + skip/take, when no sort is given', async () => {
    const { service, tx } = buildService({});

    await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 2, pageSize: 25 });

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 25, take: 25 }),
    );
  });

  it('sorts by Load # entirely DB-level (no per-load stop fetch needed)', async () => {
    const { service, tx } = buildService({});

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { sort: 'loadNumber', sortDirection: 'desc' },
      { page: 1, pageSize: 50 },
    );

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { loadNumber: 'desc' } }),
    );
    expect(tx.stop.findMany).not.toHaveBeenCalled();
  });

  it('sorts by Pickup Date without ever fetching full Load rows for the whole matching set — only bare ids, then bare stop tuples, then full rows for the one page', async () => {
    const loadFindMany = jest
      .fn()
      // 1st call: bare-id fetch for the whole filtered set
      .mockResolvedValueOnce([{ id: 'load-a' }, { id: 'load-b' }, { id: 'load-c' }])
      // 2nd call: full rows for just the page's ids
      .mockResolvedValueOnce([
        load({ id: 'load-b', loadNumber: 'LOAD-B' }),
        load({ id: 'load-a', loadNumber: 'LOAD-A' }),
      ]);
    const stopFindMany = jest.fn().mockResolvedValue([
      {
        loadId: 'load-a',
        sequence: 1,
        appointmentDatetime: new Date('2026-03-01'),
        stopType: 'PICKUP',
      },
      {
        loadId: 'load-b',
        sequence: 1,
        appointmentDatetime: new Date('2026-01-01'),
        stopType: 'PICKUP',
      },
      // load-c has no PICKUP stop at all — must sort last regardless of direction.
    ]);
    const { service } = buildService({ loadFindMany, stopFindMany });

    const result = await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { sort: 'pickupDate', sortDirection: 'asc' },
      { page: 1, pageSize: 2 },
    );

    // Only bare ids were requested for the full set — never `include: { stops: true }`.
    expect(loadFindMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({ select: { id: true } }),
    );
    // Bare stop tuples only, not full stop rows.
    expect(stopFindMany).toHaveBeenCalledWith({
      where: { loadId: { in: ['load-a', 'load-b', 'load-c'] }, stopType: 'PICKUP' },
      select: { loadId: true, sequence: true, appointmentDatetime: true, stopType: true },
    });
    // load-b (Jan) sorts before load-a (Mar); load-c (no stop) would be last but is excluded by pageSize 2.
    expect(loadFindMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({ where: { id: { in: ['load-b', 'load-a'] } } }),
    );
    expect((result.items as { id: string }[]).map((i) => i.id)).toEqual(['load-b', 'load-a']);
  });

  it('uses lowest-sequence PICKUP / highest-sequence DELIVERY, not min/max appointmentDatetime — matches frontend loadDerived.ts exactly', async () => {
    const loadFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'load-a' }, { id: 'load-b' }])
      .mockResolvedValueOnce([load({ id: 'load-a' }), load({ id: 'load-b' })]);
    // load-a's first-by-sequence (seq1) stop is LATER (07-20) than its other
    // stop (seq2, 07-01) — a naive MIN(appointmentDatetime) would wrongly pick
    // 07-01. load-b has a single stop dated 07-10, strictly between the two,
    // so the sort order alone proves which date load-a's derivation actually
    // used: sequence-correct (07-20) sorts load-b BEFORE load-a; a
    // min/max-appointmentDatetime bug (07-01) would sort load-a BEFORE load-b.
    const stopFindMany = jest.fn().mockResolvedValue([
      {
        loadId: 'load-a',
        sequence: 1,
        appointmentDatetime: new Date('2026-07-20'),
        stopType: 'PICKUP',
      },
      {
        loadId: 'load-a',
        sequence: 2,
        appointmentDatetime: new Date('2026-07-01'),
        stopType: 'PICKUP',
      },
      {
        loadId: 'load-b',
        sequence: 1,
        appointmentDatetime: new Date('2026-07-10'),
        stopType: 'PICKUP',
      },
    ]);
    const { service } = buildService({ loadFindMany, stopFindMany });

    const result = await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { sort: 'pickupDate', sortDirection: 'asc' },
      { page: 1, pageSize: 50 },
    );

    expect((result.items as { id: string }[]).map((i) => i.id)).toEqual(['load-b', 'load-a']);
  });
});

describe('LoadSearchService.search — financial redaction', () => {
  it('reuses shapeFinancialFieldsList — a Dispatcher never sees customerRate/carrierRate', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([load({ customerRate: '1800.00' })]);
    const { service } = buildService({ loadFindMany });

    const result = await service.search(
      ORG_ID,
      USER_ID,
      ['DISPATCHER'],
      {},
      {
        page: 1,
        pageSize: 50,
      },
    );

    expect(result.items[0]).toEqual(
      expect.objectContaining({ customerRate: null, carrierRate: null }),
    );
  });
});

describe('LoadSearchService.exportCsv', () => {
  it('fetches every matching row with no pagination, includes a CSV header, and redacts per role', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([
      load({
        loadNumber: 'LOAD-000009',
        customer: { legalName: 'Acme, Inc.' },
        assignedCarrier: null,
        assignedDispatcher: null,
        customerRate: '1800.00',
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            city: 'Dallas',
            state: 'TX',
            appointmentDatetime: null,
          },
          {
            sequence: 2,
            stopType: 'DELIVERY',
            city: 'Chicago',
            state: 'IL',
            appointmentDatetime: null,
          },
        ],
      }),
    ]);
    const { service, tx } = buildService({ loadFindMany });

    const csv = await service.exportCsv(ORG_ID, USER_ID, ['DISPATCHER'], {});

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { stops: true, customer: true, assignedCarrier: true, assignedDispatcher: true },
      }),
    );
    expect(tx.load.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ take: expect.anything() }),
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'Load #,Customer,Status,Risk,Carrier,Dispatcher,Origin → Destination,Pickup Date,Delivery Date,Equipment,Customer Rate,Carrier Rate',
    );
    // Comma inside the customer name must be quoted per RFC-4180.
    expect(lines[1]).toContain('"Acme, Inc."');
    // Dispatcher role — redacted customerRate renders as an empty CSV field, never "null".
    expect(lines[1].endsWith(',,')).toBe(true);
  });
});

describe('LoadSearchService.exportCsv — Dispatch Board Phase 18 additions', () => {
  it('scopes the export to exactly the given ids ("Export Selected")', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([]);
    const { service, tx } = buildService({ loadFindMany });

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], { ids: ['load-a', 'load-b'] });

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          id: { in: ['load-a', 'load-b'] },
        }),
      }),
    );
  });

  it('does not add an id filter when ids is an empty array', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([]);
    const { service, tx } = buildService({ loadFindMany });

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], { ids: [] });

    const where = (tx.load.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).not.toHaveProperty('id');
  });

  it('excludes CLOSED loads when excludeClosed is true and no explicit status is given', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([]);
    const { service, tx } = buildService({ loadFindMany });

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], { excludeClosed: true });

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { notIn: ['CLOSED'] } }),
      }),
    );
  });

  it('lets an explicit status win over excludeClosed — never combines the two', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([]);
    const { service, tx } = buildService({ loadFindMany });

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], {
      status: 'DISPATCHED',
      excludeClosed: true,
    });

    const where = (tx.load.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.status).toBe('DISPATCHED');
  });

  it('adds neither an id nor a status-exclusion filter when ids/excludeClosed are both absent', async () => {
    const loadFindMany = jest.fn().mockResolvedValue([]);
    const { service, tx } = buildService({ loadFindMany });

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], {});

    const where = (tx.load.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).not.toHaveProperty('id');
    expect(where).not.toHaveProperty('status');
  });
});
