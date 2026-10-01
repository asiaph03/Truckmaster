import { MissingPodSweepService } from './missing-pod-sweep.service';

const NOW = Date.now();
const DELIVERED_AUDIT_ACTION = 'Load Status Advanced — Delivered';

interface FakeStop {
  id: string;
  stopType: 'PICKUP' | 'DELIVERY' | 'OTHER';
  stopPurpose: 'STANDARD' | 'RETURN';
}

interface FakeLoad {
  id: string;
  loadNumber: string;
  status: 'DELIVERED' | 'CLOSED';
  closedAt: Date | null;
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

/** Builds a tx mock given per-org loads, a per-org AttentionItem store, pre-seeded AuditLog 'delivered' entries, and pre-seeded POD Document rows. */
function buildTx(
  loads: FakeLoad[],
  attentionItem: ReturnType<typeof createAttentionItemStore>,
  deliveredAuditByLoadId: Map<string, Date>,
  podDocumentStopIds: Set<string>,
) {
  return {
    load: { findMany: jest.fn().mockResolvedValue(loads) },
    auditLog: {
      findMany: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { entityId: { in: string[] }; action: string } }) => {
            if (where.action !== DELIVERED_AUDIT_ACTION) return Promise.resolve([]);
            const entries = where.entityId.in
              .filter((id) => deliveredAuditByLoadId.has(id))
              .map((id) => ({ entityId: id, createdAt: deliveredAuditByLoadId.get(id)! }));
            return Promise.resolve(entries);
          },
        ),
    },
    document: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { entityId: { in: string[] } } }) => {
          const matches = where.entityId.in
            .filter((id) => podDocumentStopIds.has(id))
            .map((id) => ({ entityId: id }));
          return Promise.resolve(matches);
        }),
    },
    attentionItem,
  };
}

function buildService(
  loadsByOrg: Record<string, FakeLoad[]>,
  deliveredAuditByOrg: Record<string, Map<string, Date>> = {},
  podDocumentStopIdsByOrg: Record<string, Set<string>> = {},
) {
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
      .mockImplementation((orgId: string, fn: (tx: unknown) => unknown) =>
        fn(
          buildTx(
            loadsByOrg[orgId] ?? [],
            storeFor(orgId),
            deliveredAuditByOrg[orgId] ?? new Map(),
            podDocumentStopIdsByOrg[orgId] ?? new Set(),
          ),
        ),
      ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new MissingPodSweepService(prisma as never, audit as never);
  return { service, prisma, audit, storesByOrg };
}

function buildRunAgainstStore(
  store: ReturnType<typeof createAttentionItemStore>,
  orgId: string,
  deliveredAuditByLoadId: Map<string, Date>,
  podDocumentStopIds: Set<string>,
) {
  return (loads: FakeLoad[]) => {
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: orgId }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
          fn(buildTx(loads, store, deliveredAuditByLoadId, podDocumentStopIds)),
        ),
    };
    return new MissingPodSweepService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
  };
}

const ORG = 'org-1';

function hoursAgo(hours: number): Date {
  return new Date(NOW - hours * 3600000);
}

function closedQualifyingLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000100',
    status: 'CLOSED',
    closedAt: hoursAgo(100),
    stops: [{ id: 'stop-1', stopType: 'DELIVERY', stopPurpose: 'STANDARD' }],
    ...overrides,
  };
}

function freshClosedLoad(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return closedQualifyingLoad({ closedAt: hoursAgo(1), ...overrides });
}

describe('MissingPodSweepService — AttentionItem lifecycle (B.8)', () => {
  it('creates a single ACTIVE AttentionItem for a newly-qualifying load (CLOSED, no POD document)', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [closedQualifyingLoad()] });

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        loadId: 'load-1',
        type: 'MISSING_POD',
        status: 'ACTIVE',
        severity: 'HIGH',
      }),
    );
  });

  it('creates an ACTIVE item for a qualifying DELIVERED load using the delivered-transition AuditLog clock', async () => {
    const deliveredAudit = new Map([['load-1', hoursAgo(100)]]);
    const { service, storesByOrg } = buildService(
      {
        [ORG]: [
          {
            id: 'load-1',
            loadNumber: 'LOAD-000101',
            status: 'DELIVERED',
            closedAt: null,
            stops: [{ id: 'stop-1', stopType: 'DELIVERY', stopPurpose: 'STANDARD' }],
          },
        ],
      },
      { [ORG]: deliveredAudit },
    );

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows).toHaveLength(1);
    expect((rows[0].metadata as Record<string, unknown>).clockBasis).toBe('deliveredAuditEntry');
  });

  it('an existing ACTIVE item is updated in place, never duplicated, across repeated runs', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [closedQualifyingLoad()] });

    await service.run();
    await service.run();

    const store = storesByOrg.get(ORG)!;
    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it('reactivates a RESOLVED item when the condition recurs on the same load', async () => {
    const store = createAttentionItemStore();
    const buildRun = buildRunAgainstStore(store, ORG, new Map(), new Set());

    await buildRun([closedQualifyingLoad()]).run();
    const id = [...store.rows.keys()][0];
    const firstDetectedAt = store.rows.get(id)!.detectedAt;

    await buildRun([freshClosedLoad()]).run(); // resolve (now under 48h)
    expect(store.rows.get(id)!.status).toBe('RESOLVED');

    await new Promise((r) => setTimeout(r, 2));
    await buildRun([closedQualifyingLoad()]).run(); // recurs — but closedAt is fixed per load in real life;
    // here we simulate recurrence by reusing the same old closedAt again.

    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)!.status).toBe('ACTIVE');
    expect(store.rows.get(id)!.resolvedAt).toBeNull();
    expect(store.rows.get(id)!.detectedAt).not.toBe(firstDetectedAt);
  });

  it('resolves an ACTIVE item once a POD document is created, regardless of scan status', async () => {
    const store = createAttentionItemStore();
    const buildRun = (loads: FakeLoad[], podDocumentStopIds: Set<string>) =>
      buildRunAgainstStore(store, ORG, new Map(), podDocumentStopIds)(loads);

    await buildRun([closedQualifyingLoad()], new Set()).run();
    const id = [...store.rows.keys()][0];
    expect(store.rows.get(id)!.status).toBe('ACTIVE');

    // A POD document now exists for stop-1 (any scanStatus — e.g. SCAN_FAILED
    // from the intentional Cloudmersive free-tier override — still counts).
    await buildRun([closedQualifyingLoad()], new Set(['stop-1'])).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('resolves a lingering ACTIVE item when its Load leaves DELIVERED/CLOSED scope entirely', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [closedQualifyingLoad()] });
    await service.run();

    const store = storesByOrg.get(ORG)!;
    const id = [...store.rows.keys()][0];

    await buildRunAgainstStore(store, ORG, new Map(), new Set())([]).run();

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it('multiple sweeps in a row never create duplicate AttentionItems for the same load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [closedQualifyingLoad()] });

    await service.run();
    await service.run();
    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('tenant isolation: each organization only ever sees and mutates its own AttentionItem rows', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const { service, storesByOrg, prisma } = buildService({
      [orgA]: [closedQualifyingLoad({ id: 'load-a' })],
      [orgB]: [closedQualifyingLoad({ id: 'load-b' })],
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

  it('synthetic/test organizations receive no special hardcoded filtering — normal business logic alone determines eligibility', async () => {
    // A load in an org literally named "Test Org" still qualifies/resolves
    // purely based on status + POD-document existence + age, exactly like
    // any other org. No org-name or org-type branch exists anywhere in
    // this service.
    const { service, storesByOrg } = buildService({ 'test-org-fixture': [closedQualifyingLoad()] });

    await service.run();

    expect(storesByOrg.get('test-org-fixture')!.rows.size).toBe(1);
  });

  it('both DELIVERED and CLOSED loads are evaluated in the same sweep pass', async () => {
    const deliveredAudit = new Map([['load-delivered', hoursAgo(100)]]);
    const { service, storesByOrg } = buildService(
      {
        [ORG]: [
          closedQualifyingLoad({ id: 'load-closed' }),
          {
            id: 'load-delivered',
            loadNumber: 'LOAD-000102',
            status: 'DELIVERED',
            closedAt: null,
            stops: [{ id: 'stop-2', stopType: 'DELIVERY', stopPurpose: 'STANDARD' }],
          },
        ],
      },
      { [ORG]: deliveredAudit },
    );

    await service.run();

    const rows = [...storesByOrg.get(ORG)!.rows.values()];
    expect(rows.map((r) => r.loadId).sort()).toEqual(['load-closed', 'load-delivered']);
  });

  it('a load with a SCAN_FAILED POD document is excluded (intentional Cloudmersive free-tier override, not MISSING_POD)', async () => {
    const { service, storesByOrg } = buildService(
      { [ORG]: [closedQualifyingLoad()] },
      {},
      { [ORG]: new Set(['stop-1']) }, // a POD document row exists for stop-1, regardless of its scanStatus
    );

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });

  it('never guesses a clock — a DELIVERED load with no resolvable AuditLog entry is not flagged', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [
        {
          id: 'load-1',
          loadNumber: 'LOAD-000103',
          status: 'DELIVERED',
          closedAt: null,
          stops: [{ id: 'stop-1', stopType: 'DELIVERY', stopPurpose: 'STANDARD' }],
        },
      ],
    });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(0);
  });

  it('evaluates a load with no assigned dispatcher field at all — detection is not gated on assignedDispatcherId', async () => {
    // FakeLoad intentionally carries no assignedDispatcherId field (the
    // select in loadCandidates never fetches it) — matches every prior
    // detector's precedent.
    const { service, storesByOrg } = buildService({ [ORG]: [closedQualifyingLoad()] });

    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });
});
