import { StaleLocationSweepService } from './stale-location-sweep.service';

interface FakeLoad {
  id: string;
  loadNumber: string;
  currentLocationUpdatedAt: Date | null;
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
  const service = new StaleLocationSweepService(prisma as never, audit as never);
  return { service, prisma, audit, storesByOrg };
}

const ORG = 'org-1';
const NOW = Date.now();

function staleLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000101',
    currentLocationUpdatedAt: new Date(NOW - 200 * 60000), // 200min ago -> HIGH
    ...overrides,
  };
}

function freshLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return staleLoad({ currentLocationUpdatedAt: new Date(NOW - 10 * 60000), ...overrides }); // 10min ago -> not stale
}

function neverCheckedInLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return staleLoad({ currentLocationUpdatedAt: null, ...overrides });
}

describe('StaleLocationSweepService — AttentionItem lifecycle', () => {
  it('creates a single ACTIVE AttentionItem for a newly-stale load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [staleLoad()] });

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        loadId: 'load-1',
        type: 'STALE_LOCATION',
        status: 'ACTIVE',
        severity: 'HIGH',
        title: 'Stale Location',
      }),
    );
  });

  it('does nothing for a load with no currentLocationUpdatedAt (never checked in)', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [neverCheckedInLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });

  it('does nothing for a fresh location', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [freshLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });

  it('an existing ACTIVE item is updated in place, never duplicated, across repeated runs', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [staleLoad()] });

    await service.run();
    await service.run();

    const store = storesByOrg.get(ORG)!;
    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1); // second run updates the same row
  });

  it('resolves an ACTIVE item once currentLocationUpdatedAt is refreshed (a new Check Call arrives)', async () => {
    const store = createAttentionItemStore();
    const buildRun = (loads: FakeLoad[]) => {
      const prisma = {
        organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
        withTenantTransaction: jest
          .fn()
          .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
            fn({ load: { findMany: jest.fn().mockResolvedValue(loads) }, attentionItem: store }),
          ),
      };
      return new StaleLocationSweepService(
        prisma as never,
        { record: jest.fn().mockResolvedValue(undefined) } as never,
      );
    };

    await buildRun([staleLoad()]).run();
    const id = [...store.rows.keys()][0];
    expect(store.rows.get(id)!.status).toBe('ACTIVE');

    await buildRun([freshLoad()]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
    expect(store.rows.get(id)!.resolvedAt).not.toBeNull();
  });

  it('reactivates a RESOLVED item (refreshing detectedAt) when staleness recurs on the same load', async () => {
    const store = createAttentionItemStore();
    const buildRun = (loads: FakeLoad[]) => {
      const prisma = {
        organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
        withTenantTransaction: jest
          .fn()
          .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
            fn({ load: { findMany: jest.fn().mockResolvedValue(loads) }, attentionItem: store }),
          ),
      };
      return new StaleLocationSweepService(
        prisma as never,
        { record: jest.fn().mockResolvedValue(undefined) } as never,
      );
    };

    await buildRun([staleLoad()]).run(); // 1. create ACTIVE
    const id = [...store.rows.keys()][0];
    const firstDetectedAt = store.rows.get(id)!.detectedAt;

    await buildRun([freshLoad()]).run(); // 2. resolve
    expect(store.rows.get(id)!.status).toBe('RESOLVED');

    await new Promise((r) => setTimeout(r, 2));
    await buildRun([staleLoad()]).run(); // 3. staleness returns — reactivate, not a new row

    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)!.status).toBe('ACTIVE');
    expect(store.rows.get(id)!.resolvedAt).toBeNull();
    expect(store.rows.get(id)!.detectedAt).not.toBe(firstDetectedAt);
  });

  it('resolves a lingering ACTIVE item when its Load leaves the operational scope entirely (e.g. delivered)', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [staleLoad()] });
    await service.run();

    const store = storesByOrg.get(ORG)!;
    const id = [...store.rows.keys()][0];

    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
          fn({ load: { findMany: jest.fn().mockResolvedValue([]) }, attentionItem: store }),
        ),
    };
    await new StaleLocationSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    ).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('tenant isolation: each organization only ever sees and mutates its own AttentionItem rows', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const { service, storesByOrg, prisma } = buildService({
      [orgA]: [staleLoad({ id: 'load-a' })],
      [orgB]: [staleLoad({ id: 'load-b' })],
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

  it('evaluates a load with no assigned dispatcher — detection is not gated on assignedDispatcherId', async () => {
    // FakeLoad intentionally carries no assignedDispatcherId field at all
    // (the select in loadOperationalLoads never fetches it) — this test
    // documents that omission is deliberate, matching B.2's precedent.
    const { service, storesByOrg } = buildService({ [ORG]: [staleLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('multiple sweeps in a row never create duplicate AttentionItems for the same load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [staleLoad()] });

    await service.run();
    await service.run();
    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('leaves an existing, unrelated AttentionItem (different type) completely untouched', async () => {
    const store = createAttentionItemStore();
    store.rows.set('other-item', {
      id: 'other-item',
      organizationId: ORG,
      loadId: 'load-1',
      type: 'ETA_AFTER_APPOINTMENT',
      status: 'ACTIVE',
      severity: 'CRITICAL',
      title: 'Unrelated existing item',
      detectedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      resolvedAt: null,
    });
    const snapshotBefore = { ...store.rows.get('other-item') };

    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
          fn({
            load: { findMany: jest.fn().mockResolvedValue([staleLoad()]) },
            attentionItem: store,
          }),
        ),
    };
    await new StaleLocationSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    ).run();

    expect(store.rows.get('other-item')).toEqual(snapshotBefore);
    expect(store.rows.size).toBe(2); // the unrelated item + the new STALE_LOCATION one
  });
});
