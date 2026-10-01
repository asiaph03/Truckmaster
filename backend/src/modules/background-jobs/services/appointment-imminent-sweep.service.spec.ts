import { AppointmentImminentSweepService } from './appointment-imminent-sweep.service';

const NOW = Date.now();

interface FakeStop {
  sequence: number;
  stopType: 'PICKUP' | 'DELIVERY' | 'OTHER';
  status: 'PENDING' | 'ARRIVED' | 'COMPLETED';
  appointmentDatetime: Date | null;
  stopPurpose: 'STANDARD' | 'RETURN';
}

interface FakeLoad {
  id: string;
  loadNumber: string;
  currentLocationUpdatedAt: Date | null;
  dispatchRecord: { dispatchedAt: Date } | null;
  stops: FakeStop[];
}

function createAttentionItemStore() {
  const rows = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  return {
    rows,
    findUnique: jest.fn(
      async ({
        where,
      }: {
        where: {
          organizationId_loadId_type: { organizationId: string; loadId: string; type: string };
        };
      }) => {
        const key = where.organizationId_loadId_type;
        for (const row of rows.values()) {
          if (
            row.organizationId === key.organizationId &&
            row.loadId === key.loadId &&
            row.type === key.type
          ) {
            return row;
          }
        }
        return null;
      },
    ),
    findMany: jest.fn(
      async ({ where }: { where: { organizationId: string; type: string; status?: string } }) => {
        return [...rows.values()].filter(
          (r) =>
            r.organizationId === where.organizationId &&
            r.type === where.type &&
            (!where.status || r.status === where.status),
        );
      },
    ),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `item-${nextId++}`;
      const row = { id, detectedAt: new Date(), updatedAt: new Date(), resolvedAt: null, ...data };
      rows.set(id, row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    ),
  };
}

function buildService(loadsByOrg: Record<string, FakeLoad[]>) {
  const storesByOrg = new Map<string, ReturnType<typeof createAttentionItemStore>>();

  function storeFor(orgId: string) {
    if (!storesByOrg.has(orgId)) storesByOrg.set(orgId, createAttentionItemStore());
    return storesByOrg.get(orgId)!;
  }

  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue(Object.keys(loadsByOrg).map((id) => ({ id }))),
    },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) => {
        const tx = {
          load: { findMany: jest.fn().mockResolvedValue(loadsByOrg[orgId] ?? []) },
          attentionItem: storeFor(orgId),
        };
        return fn(tx);
      }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AppointmentImminentSweepService(prisma as never, audit as never);
  return { service, prisma, audit, storesByOrg };
}

/** Runs `loads` against a pre-seeded `attentionItem` store, so suppression/resolve/reactivate scenarios across sweeps share state. */
function buildRunAgainstStore(store: ReturnType<typeof createAttentionItemStore>, orgId: string) {
  return (loads: FakeLoad[]) => {
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: orgId }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
          fn({ load: { findMany: jest.fn().mockResolvedValue(loads) }, attentionItem: store }),
        ),
    };
    return new AppointmentImminentSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
  };
}

const ORG = 'org-1';

function minutesFromNow(minutes: number): Date {
  return new Date(NOW + minutes * 60000);
}

function qualifyingStop(overrides: Partial<FakeStop> = {}): FakeStop {
  return {
    sequence: 1,
    stopType: 'PICKUP',
    status: 'PENDING',
    appointmentDatetime: minutesFromNow(90),
    stopPurpose: 'STANDARD',
    ...overrides,
  };
}

/** Qualifies at MEDIUM: appointment in 90 min, last activity 150 min ago. */
function qualifyingLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000101',
    currentLocationUpdatedAt: minutesFromNow(-150),
    dispatchRecord: null,
    stops: [qualifyingStop()],
    ...overrides,
  };
}

function freshLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return qualifyingLoad({ currentLocationUpdatedAt: minutesFromNow(-10), ...overrides });
}

describe('AppointmentImminentSweepService — AttentionItem lifecycle', () => {
  it('15. creates a single ACTIVE AttentionItem for a newly-qualifying load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [qualifyingLoad()] });

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        loadId: 'load-1',
        type: 'APPOINTMENT_IMMINENT_NO_CHECK_CALL',
        status: 'ACTIVE',
        severity: 'MEDIUM',
      }),
    );
  });

  it('16. an existing ACTIVE item is updated in place, never duplicated, across repeated runs', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [qualifyingLoad()] });

    await service.run();
    await service.run();

    const store = storesByOrg.get(ORG)!;
    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it('17. reactivates a RESOLVED item (refreshing detectedAt) when the condition recurs on the same load', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run(); // create ACTIVE
    const id = [...store.rows.keys()][0];
    const firstDetectedAt = store.rows.get(id)!.detectedAt;

    await buildRun([freshLoad()]).run(); // resolve
    expect(store.rows.get(id)!.status).toBe('RESOLVED');

    await new Promise((r) => setTimeout(r, 2));
    await buildRun([qualifyingLoad()]).run(); // recurs — reactivate, not a new row

    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)!.status).toBe('ACTIVE');
    expect(store.rows.get(id)!.resolvedAt).toBeNull();
    expect(store.rows.get(id)!.detectedAt).not.toBe(firstDetectedAt);
  });

  it('18. resolves an ACTIVE item once activity becomes recent (a new Check Call arrives)', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run();
    const id = [...store.rows.keys()][0];
    expect(store.rows.get(id)!.status).toBe('ACTIVE');

    await buildRun([freshLoad()]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
    expect(store.rows.get(id)!.resolvedAt).not.toBeNull();
  });

  it('19. resolves an ACTIVE item once the appointment passes (no longer future)', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run();
    const id = [...store.rows.keys()][0];

    const passedAppointment = qualifyingLoad({
      stops: [qualifyingStop({ appointmentDatetime: minutesFromNow(-5) })],
    });
    await buildRun([passedAppointment]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('20. resolves an ACTIVE item once the applicable stop completes', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run();
    const id = [...store.rows.keys()][0];

    const completedStop = qualifyingLoad({ stops: [qualifyingStop({ status: 'COMPLETED' })] });
    await buildRun([completedStop]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('21. resolves a lingering ACTIVE item when its Load leaves the operational scope entirely', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [qualifyingLoad()] });
    await service.run();

    const store = storesByOrg.get(ORG)!;
    const id = [...store.rows.keys()][0];

    await buildRunAgainstStore(store, ORG)([]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('22. multiple sweeps in a row never create duplicate AttentionItems for the same load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [qualifyingLoad()] });

    await service.run();
    await service.run();
    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('23. tenant isolation: each organization only ever sees and mutates its own AttentionItem rows', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const { service, storesByOrg, prisma } = buildService({
      [orgA]: [qualifyingLoad({ id: 'load-a' })],
      [orgB]: [qualifyingLoad({ id: 'load-b' })],
    });

    await service.run();

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(orgA, expect.any(Function));
    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(orgB, expect.any(Function));

    const rowsA = [...storesByOrg.get(orgA)!.rows.values()];
    const rowsB = [...storesByOrg.get(orgB)!.rows.values()];
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0].loadId).toBe('load-a');
    expect(rowsB[0].loadId).toBe('load-b');
  });

  it('24. evaluates a load with no assigned dispatcher — detection is not gated on assignedDispatcherId', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [qualifyingLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('25. an ACTIVE STALE_LOCATION item suppresses creation of APPOINTMENT_IMMINENT_NO_CHECK_CALL', async () => {
    const store = createAttentionItemStore();
    store.rows.set('stale-1', {
      id: 'stale-1',
      organizationId: ORG,
      loadId: 'load-1',
      type: 'STALE_LOCATION',
      status: 'ACTIVE',
      severity: 'HIGH',
      detectedAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
    });
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run();

    const appointmentItems = [...store.rows.values()].filter(
      (r) => r.type === 'APPOINTMENT_IMMINENT_NO_CHECK_CALL',
    );
    expect(appointmentItems).toHaveLength(0);
  });

  it('26. an ACTIVE APPOINTMENT_IMMINENT_NO_CHECK_CALL item resolves on the next sweep once STALE_LOCATION becomes ACTIVE', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG);

    await buildRun([qualifyingLoad()]).run(); // creates ACTIVE (no suppression yet)
    const id = [...store.rows.keys()].find(
      (key) => store.rows.get(key)!.type === 'APPOINTMENT_IMMINENT_NO_CHECK_CALL',
    )!;
    expect(store.rows.get(id)!.status).toBe('ACTIVE');

    store.rows.set('stale-1', {
      id: 'stale-1',
      organizationId: ORG,
      loadId: 'load-1',
      type: 'STALE_LOCATION',
      status: 'ACTIVE',
      severity: 'HIGH',
      detectedAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
    });

    await buildRun([qualifyingLoad()]).run(); // STALE_LOCATION now ACTIVE — B.6 must resolve

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('27. a load whose nearest-in-time appointment is in the past never alerts (real LOAD-000118-equivalent case)', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000118',
          currentLocationUpdatedAt: minutesFromNow(-133),
          dispatchRecord: null,
          stops: [qualifyingStop({ appointmentDatetime: minutesFromNow(-425) })],
        },
      ],
    });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });
});
