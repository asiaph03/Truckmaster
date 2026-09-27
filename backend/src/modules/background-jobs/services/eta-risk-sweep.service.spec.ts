import { EtaRiskSweepService } from './eta-risk-sweep.service';

interface FakeLoad {
  id: string;
  loadNumber: string;
  currentEta: Date | null;
  stops: {
    stopType: 'PICKUP' | 'DELIVERY' | 'OTHER';
    status: 'PENDING' | 'ARRIVED' | 'COMPLETED';
    appointmentDatetime: Date | null;
    sequence: number;
    stopPurpose: 'STANDARD' | 'RETURN';
  }[];
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
  const service = new EtaRiskSweepService(prisma as never, audit as never);
  return { service, prisma, audit, storesByOrg };
}

const ORG = 'org-1';

function riskyLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000101',
    currentEta: new Date('2026-09-05T20:18:00.000Z'), // 78min after the appointment below
    stops: [
      {
        stopType: 'PICKUP',
        status: 'PENDING',
        appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'),
        sequence: 1,
        stopPurpose: 'STANDARD',
      },
    ],
    ...overrides,
  };
}

function safeLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return riskyLoad({ currentEta: null, ...overrides });
}

describe('EtaRiskSweepService — AttentionItem lifecycle', () => {
  it('creates a single ACTIVE AttentionItem for a newly at-risk load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [riskyLoad()] });

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        loadId: 'load-1',
        type: 'ETA_AFTER_APPOINTMENT',
        status: 'ACTIVE',
        severity: 'CRITICAL',
        title: 'Pickup at Risk',
      }),
    );
  });

  it('an existing ACTIVE item is updated in place, never duplicated, across repeated runs', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [riskyLoad()] });

    await service.run();
    await service.run();

    const store = storesByOrg.get(ORG)!;
    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1); // second run updates the same row
  });

  it('resolves an ACTIVE item when the ETA risk clears', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [riskyLoad()] });
    await service.run();

    const store = storesByOrg.get(ORG)!;
    const activeId = [...store.rows.keys()][0];
    expect(store.rows.get(activeId)!.status).toBe('ACTIVE');

    // Second sweep pass: the same underlying store, but this time the Load
    // is no longer at risk (no ETA at all) — rebuild the service with an
    // updated load list while reusing the same AttentionItem store.
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) => {
          const tx = {
            load: { findMany: jest.fn().mockResolvedValue([safeLoad()]) },
            attentionItem: store,
          };
          return fn(tx);
        }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const rerunService = new EtaRiskSweepService(prisma as never, audit as never);
    await rerunService.run();

    expect(store.rows.get(activeId)!.status).toBe('RESOLVED');
    expect(store.rows.get(activeId)!.resolvedAt).not.toBeNull();
  });

  it('reactivates a RESOLVED item (refreshing detectedAt) when the same risk recurs on the same load', async () => {
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
      return new EtaRiskSweepService(
        prisma as never,
        { record: jest.fn().mockResolvedValue(undefined) } as never,
      );
    };

    await buildRun([riskyLoad()]).run(); // 1. create ACTIVE
    const id = [...store.rows.keys()][0];
    const firstDetectedAt = store.rows.get(id)!.detectedAt;

    await buildRun([safeLoad()]).run(); // 2. resolve
    expect(store.rows.get(id)!.status).toBe('RESOLVED');

    await new Promise((r) => setTimeout(r, 2));
    await buildRun([riskyLoad()]).run(); // 3. risk returns — reactivate, not a new row

    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)!.status).toBe('ACTIVE');
    expect(store.rows.get(id)!.resolvedAt).toBeNull();
    expect(store.rows.get(id)!.detectedAt).not.toBe(firstDetectedAt);
  });

  it('resolves a lingering ACTIVE item when its Load leaves the operational scope entirely (e.g. delivered)', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [riskyLoad()] });
    await service.run(); // creates ACTIVE

    const store = storesByOrg.get(ORG)!;
    const id = [...store.rows.keys()][0];

    // Second pass: the Load no longer appears in the operational query at
    // all (e.g. it's now DELIVERED) — simulate via an empty loads array.
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
          fn({ load: { findMany: jest.fn().mockResolvedValue([]) }, attentionItem: store }),
        ),
    };
    await new EtaRiskSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    ).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('tenant isolation: each organization only ever sees and mutates its own AttentionItem rows', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const { service, storesByOrg, prisma } = buildService({
      [orgA]: [riskyLoad({ id: 'load-a' })],
      [orgB]: [riskyLoad({ id: 'load-b' })],
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

  it('a Load with multiple qualifying stops still produces exactly one AttentionItem (unique key is org+load+type, not per-stop)', async () => {
    const load = riskyLoad({
      stops: [
        {
          stopType: 'PICKUP',
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-05T19:00:00.000Z'),
          sequence: 1,
          stopPurpose: 'STANDARD',
        },
        {
          stopType: 'DELIVERY',
          status: 'PENDING',
          appointmentDatetime: new Date('2026-09-05T18:00:00.000Z'),
          sequence: 2,
          stopPurpose: 'STANDARD',
        },
      ],
    });
    const { service, storesByOrg } = buildService({ [ORG]: [load] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('leaves an existing, unrelated AttentionItem (different type) completely untouched', async () => {
    const store = createAttentionItemStore();
    store.rows.set('other-item', {
      id: 'other-item',
      organizationId: ORG,
      loadId: 'load-1',
      type: 'CHECK_CALL_OVERDUE',
      status: 'ACTIVE',
      severity: 'HIGH',
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
            load: { findMany: jest.fn().mockResolvedValue([riskyLoad()]) },
            attentionItem: store,
          }),
        ),
    };
    await new EtaRiskSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    ).run();

    expect(store.rows.get('other-item')).toEqual(snapshotBefore);
    expect(store.rows.size).toBe(2); // the unrelated item + the new ETA_AFTER_APPOINTMENT one
  });

  it('does nothing at all for a load with no risk and no existing item', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [safeLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });
});
