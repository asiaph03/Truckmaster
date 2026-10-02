import { Logger } from '@nestjs/common';
import { ManualRiskFlagSweepService } from './manual-risk-flag-sweep.service';

type LoadStatus =
  | 'BOOKED'
  | 'CARRIER_SOURCING'
  | 'CARRIER_ASSIGNED'
  | 'RATE_CONFIRMATION'
  | 'DISPATCHED'
  | 'PICKUP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CLOSED'
  | 'CANCELLED';
type RiskStatus = 'NORMAL' | 'AT_RISK' | 'DELAYED';

interface FakeLoad {
  id: string;
  loadNumber: string;
  status: LoadStatus;
  riskStatus: RiskStatus;
  riskReason: string | null;
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

type Store = ReturnType<typeof createAttentionItemStore>;

/** A fake `load.findMany` that genuinely applies the sweep's own `where` (org, status IN, riskStatus NOT) to the full fake set — so scope behavior is exercised, not hand-fed. */
function createLoadTable(loadsByOrg: Record<string, FakeLoad[]>) {
  const findMany = jest.fn(
    async ({
      where,
    }: {
      where: {
        organizationId: string;
        status?: { in: LoadStatus[] };
        riskStatus?: { not: RiskStatus };
      };
    }) =>
      (loadsByOrg[where.organizationId] ?? [])
        .filter((l) => (where.status ? where.status.in.includes(l.status) : true))
        .filter((l) => (where.riskStatus ? l.riskStatus !== where.riskStatus.not : true))
        .map(({ id, loadNumber, riskStatus, riskReason }) => ({
          id,
          loadNumber,
          riskStatus,
          riskReason,
        })),
  );
  const update = jest.fn();
  return { findMany, update };
}

function buildService(loadsByOrg: Record<string, FakeLoad[]>, stores?: Map<string, Store>) {
  const storesByOrg = stores ?? new Map<string, Store>();
  const loadTable = createLoadTable(loadsByOrg);

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
        fn({ load: loadTable, attentionItem: storeFor(orgId) }),
      ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ManualRiskFlagSweepService(prisma as never, audit as never);
  return { service, prisma, audit, storesByOrg, loadTable };
}

/** Runs a fresh sweep over `loads` against a pre-existing `attentionItem` store, so lifecycle scenarios across sweeps share state. */
function runAgainstStore(store: Store, orgId: string, loads: FakeLoad[]) {
  const stores = new Map<string, Store>([[orgId, store]]);
  return buildService({ [orgId]: loads }, stores).service.run();
}

const ORG = 'org-1';

function load(overrides: Partial<FakeLoad> = {}): FakeLoad {
  return {
    id: 'load-1',
    loadNumber: 'LOAD-000101',
    status: 'IN_TRANSIT',
    riskStatus: 'AT_RISK',
    riskReason: 'Driver reports a flat tire',
    ...overrides,
  };
}

function itemsOf(store: Store, type = 'MANUAL_RISK_FLAG') {
  return [...store.rows.values()].filter((r) => r.type === type);
}

describe('ManualRiskFlagSweepService — B.9 AttentionItem lifecycle', () => {
  it('AT_RISK creates a single ACTIVE MEDIUM AttentionItem', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [load()] });

    await service.run();

    const rows = itemsOf(storesByOrg.get(ORG)!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        loadId: 'load-1',
        type: 'MANUAL_RISK_FLAG',
        status: 'ACTIVE',
        severity: 'MEDIUM',
        title: 'Dispatcher Flagged: At Risk',
        suggestedActions: [{ type: 'VIEW_LOAD' }],
      }),
    );
  });

  it('DELAYED creates a single ACTIVE HIGH AttentionItem', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [load({ riskStatus: 'DELAYED', riskReason: 'Accident on I-95' })],
    });

    await service.run();

    const rows = itemsOf(storesByOrg.get(ORG)!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        severity: 'HIGH',
        title: 'Dispatcher Flagged: Delayed',
      }),
    );
  });

  it('never creates a CRITICAL item', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [load({ id: 'a' }), load({ id: 'b', riskStatus: 'DELAYED' })],
    });

    await service.run();

    for (const row of itemsOf(storesByOrg.get(ORG)!)) {
      expect(row.severity).not.toBe('CRITICAL');
    }
  });

  it('copies riskReason verbatim into the AttentionItem reason, and records only { riskStatus } as metadata', async () => {
    const verbatim = "Driver's reefer is not starting — 4 hours and 23 minutes away.";
    const { service, storesByOrg } = buildService({ [ORG]: [load({ riskReason: verbatim })] });

    await service.run();

    const [row] = itemsOf(storesByOrg.get(ORG)!);
    expect(row.reason).toBe(verbatim);
    expect(row.metadata).toEqual({ riskStatus: 'AT_RISK' });
  });

  it('operates on PICKUP and DISPATCHED loads too, not only IN_TRANSIT', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [
        load({ id: 'a', status: 'DISPATCHED' }),
        load({ id: 'b', status: 'PICKUP' }),
        load({ id: 'c', status: 'IN_TRANSIT' }),
      ],
    });

    await service.run();

    expect(itemsOf(storesByOrg.get(ORG)!)).toHaveLength(3);
  });

  it('queries only operational, non-NORMAL loads, scoped to the organization', async () => {
    const { service, loadTable } = buildService({ [ORG]: [load()] });

    await service.run();

    expect(loadTable.findMany).toHaveBeenCalledTimes(1);
    expect(loadTable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          status: { in: ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] },
          riskStatus: { not: 'NORMAL' },
        },
      }),
    );
  });

  it('an existing ACTIVE item is updated in place when still flagged, never duplicated, across repeated runs', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [load()] });

    await service.run();
    await service.run();
    await service.run();

    const store = storesByOrg.get(ORG)!;
    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(2);
  });

  it('refreshes severity, title, reason, and metadata in place when AT_RISK escalates to DELAYED', async () => {
    const store = createAttentionItemStore();

    await runAgainstStore(store, ORG, [load()]);
    const id = [...store.rows.keys()][0];
    expect(store.rows.get(id)).toEqual(expect.objectContaining({ severity: 'MEDIUM' }));

    await runAgainstStore(store, ORG, [
      load({ riskStatus: 'DELAYED', riskReason: 'Now stuck at a closed bridge' }),
    ]);

    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        severity: 'HIGH',
        title: 'Dispatcher Flagged: Delayed',
        reason: 'Now stuck at a closed bridge',
        metadata: { riskStatus: 'DELAYED' },
      }),
    );
  });

  it('refreshes the reason in place when the dispatcher edits it while the status stays AT_RISK', async () => {
    const store = createAttentionItemStore();

    await runAgainstStore(store, ORG, [load({ riskReason: 'first note' })]);
    await runAgainstStore(store, ORG, [load({ riskReason: 'updated note' })]);

    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0].reason).toBe('updated note');
  });

  it('NORMAL resolves an existing ACTIVE item (flag cleared by the dispatcher)', async () => {
    const store = createAttentionItemStore();
    await runAgainstStore(store, ORG, [load()]);
    const id = [...store.rows.keys()][0];
    expect(store.rows.get(id)!.status).toBe('ACTIVE');

    await runAgainstStore(store, ORG, [load({ riskStatus: 'NORMAL', riskReason: null })]);

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
    expect(store.rows.get(id)!.resolvedAt).not.toBeNull();
  });

  it('a load that leaves operational status (DELIVERED) resolves its existing ACTIVE item, even though riskStatus is still AT_RISK', async () => {
    const store = createAttentionItemStore();
    await runAgainstStore(store, ORG, [load()]);
    const id = [...store.rows.keys()][0];

    await runAgainstStore(store, ORG, [load({ status: 'DELIVERED' })]);

    expect(store.rows.get(id)!.status).toBe('RESOLVED');
  });

  it.each(['DELIVERED', 'CLOSED', 'CANCELLED'] as const)(
    'resolves an existing ACTIVE item when its load is %s',
    async (status) => {
      const store = createAttentionItemStore();
      await runAgainstStore(store, ORG, [load()]);
      const id = [...store.rows.keys()][0];

      await runAgainstStore(store, ORG, [load({ status })]);

      expect(store.rows.get(id)!.status).toBe('RESOLVED');
    },
  );

  it('re-entering a risk state reactivates the same row (refreshing detectedAt, clearing resolvedAt) rather than creating a second', async () => {
    const store = createAttentionItemStore();

    await runAgainstStore(store, ORG, [load()]); // create ACTIVE
    const id = [...store.rows.keys()][0];
    const firstDetectedAt = store.rows.get(id)!.detectedAt;

    await runAgainstStore(store, ORG, [load({ riskStatus: 'NORMAL', riskReason: null })]); // resolve
    expect(store.rows.get(id)!.status).toBe('RESOLVED');

    await new Promise((r) => setTimeout(r, 2));
    await runAgainstStore(store, ORG, [
      load({ riskStatus: 'DELAYED', riskReason: 'Flagged again' }),
    ]); // flagged again

    expect(store.rows.size).toBe(1);
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.rows.get(id)).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        severity: 'HIGH',
        reason: 'Flagged again',
        resolvedAt: null,
      }),
    );
    expect(store.rows.get(id)!.detectedAt).not.toBe(firstDetectedAt);
  });

  it('audit-logs Detected on create and Reactivated on reactivation, and nothing on a plain update or resolve', async () => {
    const store = createAttentionItemStore();
    const stores = new Map<string, Store>([[ORG, store]]);
    const { service, audit } = buildService({ [ORG]: [load()] }, stores);

    await service.run(); // create
    await service.run(); // update in place
    expect(audit.record.mock.calls.map((c) => c[1].action)).toEqual(['Attention Item Detected']);

    const second = buildService(
      { [ORG]: [load({ riskStatus: 'NORMAL', riskReason: null })] },
      stores,
    );
    await second.service.run(); // resolve
    expect(second.audit.record).not.toHaveBeenCalled();

    const third = buildService({ [ORG]: [load()] }, stores);
    await third.service.run(); // reactivate
    expect(third.audit.record.mock.calls.map((c) => c[1].action)).toEqual([
      'Attention Item Reactivated',
    ]);
    expect(third.audit.record.mock.calls[0][1]).toEqual(
      expect.objectContaining({ actorType: 'SYSTEM', entityType: 'Load', entityId: 'load-1' }),
    );
  });

  it('multiple sweeps in a row never create duplicate AttentionItems for the same load', async () => {
    const { service, storesByOrg } = buildService({ [ORG]: [load()] });

    await service.run();
    await service.run();
    await service.run();

    expect(storesByOrg.get(ORG)!.rows.size).toBe(1);
  });

  it('tenant isolation: each organization only ever sees and mutates its own AttentionItem rows', async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const { service, storesByOrg, prisma } = buildService({
      [orgA]: [load({ id: 'load-a', riskReason: 'org A reason' })],
      [orgB]: [load({ id: 'load-b', riskStatus: 'DELAYED', riskReason: 'org B reason' })],
    });

    await service.run();

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(orgA, expect.any(Function));
    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(orgB, expect.any(Function));

    const rowsA = itemsOf(storesByOrg.get(orgA)!);
    const rowsB = itemsOf(storesByOrg.get(orgB)!);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]).toEqual(
      expect.objectContaining({
        organizationId: orgA,
        loadId: 'load-a',
        reason: 'org A reason',
        severity: 'MEDIUM',
      }),
    );
    expect(rowsB[0]).toEqual(
      expect.objectContaining({
        organizationId: orgB,
        loadId: 'load-b',
        reason: 'org B reason',
        severity: 'HIGH',
      }),
    );
  });

  it("tenant isolation: one organization's flag clearing never resolves another organization's ACTIVE item", async () => {
    const orgA = 'org-a';
    const orgB = 'org-b';
    const first = buildService({
      [orgA]: [load({ id: 'load-a' })],
      [orgB]: [load({ id: 'load-b' })],
    });
    await first.service.run();

    const second = buildService(
      {
        [orgA]: [load({ id: 'load-a', riskStatus: 'NORMAL', riskReason: null })],
        [orgB]: [load({ id: 'load-b' })],
      },
      first.storesByOrg,
    );
    await second.service.run();

    expect(itemsOf(first.storesByOrg.get(orgA)!)[0].status).toBe('RESOLVED');
    expect(itemsOf(first.storesByOrg.get(orgB)!)[0].status).toBe('ACTIVE');
  });

  it('defensive: a null riskReason on a flagged load still creates an item with a fallback reason, never crashing or writing null', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [load({ riskStatus: 'AT_RISK', riskReason: null })],
    });

    await expect(service.run()).resolves.toBeUndefined();

    const [row] = itemsOf(storesByOrg.get(ORG)!);
    expect(row.reason).toBe('A dispatcher marked this load At Risk; no reason was recorded.');
    expect(row.status).toBe('ACTIVE');
    expect(row.severity).toBe('MEDIUM');
  });

  it('defensive: a whitespace-only riskReason is treated as missing', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [load({ riskStatus: 'DELAYED', riskReason: '   ' })],
    });

    await service.run();

    const [row] = itemsOf(storesByOrg.get(ORG)!);
    expect(row.reason).toBe('A dispatcher marked this load Delayed; no reason was recorded.');
    expect(row.severity).toBe('HIGH');
  });

  it("coexists with another ACTIVE detector on the same load — never suppressed, and never touches the other detector's row", async () => {
    const store = createAttentionItemStore();
    const staleRow = {
      id: 'stale-1',
      organizationId: ORG,
      loadId: 'load-1',
      type: 'STALE_LOCATION',
      status: 'ACTIVE',
      severity: 'HIGH',
      detectedAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
    };
    const staleSnapshot = { ...staleRow };
    store.rows.set('stale-1', staleRow);

    await runAgainstStore(store, ORG, [load()]);

    const riskItems = itemsOf(store);
    expect(riskItems).toHaveLength(1);
    expect(riskItems[0].status).toBe('ACTIVE');
    expect(itemsOf(store, 'STALE_LOCATION')).toHaveLength(1);
    expect(store.rows.get('stale-1')).toEqual(staleSnapshot);
  });

  it("clearing the flag resolves only MANUAL_RISK_FLAG — another detector's ACTIVE item on the same load stays ACTIVE", async () => {
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
    await runAgainstStore(store, ORG, [load()]);

    await runAgainstStore(store, ORG, [load({ riskStatus: 'NORMAL', riskReason: null })]);

    expect(itemsOf(store)[0].status).toBe('RESOLVED');
    expect(itemsOf(store, 'STALE_LOCATION')[0].status).toBe('ACTIVE');
  });

  it('a stale DELIVERED + AT_RISK load (real production shape) never creates an item', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [
        load({
          id: 'load-99',
          loadNumber: 'LOAD-000099',
          status: 'DELIVERED',
          riskStatus: 'AT_RISK',
          riskReason: "Driver's reefer is not starting",
        }),
      ],
    });

    await service.run();

    expect(itemsOf(storesByOrg.get(ORG)!)).toHaveLength(0);
  });

  it('a stale DELIVERED + AT_RISK load resolves through orphan handling if it already has an ACTIVE item, and the item is not re-created', async () => {
    const store = createAttentionItemStore();
    store.rows.set('item-legacy', {
      id: 'item-legacy',
      organizationId: ORG,
      loadId: 'load-99',
      type: 'MANUAL_RISK_FLAG',
      status: 'ACTIVE',
      severity: 'MEDIUM',
      detectedAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
    });
    const staleDelivered = load({ id: 'load-99', status: 'DELIVERED', riskStatus: 'AT_RISK' });

    await runAgainstStore(store, ORG, [staleDelivered]);
    await runAgainstStore(store, ORG, [staleDelivered]);

    expect(store.rows.get('item-legacy')!.status).toBe('RESOLVED');
    expect(store.rows.size).toBe(1);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('a stale DELIVERED + AT_RISK load does not block a genuinely operational flagged load in the same org', async () => {
    const { service, storesByOrg } = buildService({
      [ORG]: [
        load({ id: 'stale', status: 'DELIVERED' }),
        load({ id: 'live', status: 'IN_TRANSIT', riskStatus: 'DELAYED' }),
      ],
    });

    await service.run();

    const rows = itemsOf(storesByOrg.get(ORG)!);
    expect(rows).toHaveLength(1);
    expect(rows[0].loadId).toBe('live');
  });

  it('evaluates a load with no assigned dispatcher — detection is not gated on assignedDispatcherId', async () => {
    // FakeLoad deliberately carries no assignedDispatcherId at all and the
    // sweep's query selects none — the flag still produces an item.
    const { service, storesByOrg } = buildService({ [ORG]: [load()] });

    await service.run();

    expect(itemsOf(storesByOrg.get(ORG)!)).toHaveLength(1);
  });

  it('is a pure read-only consumer of Load: never writes riskStatus/riskReason or any other Load field', async () => {
    const { service, loadTable } = buildService({
      [ORG]: [load(), load({ id: 'stale', status: 'DELIVERED' })],
    });

    await service.run();

    expect(loadTable.update).not.toHaveBeenCalled();
  });

  it('a failure on one load is isolated — logged, counted, and the remaining loads and orphan pass still run', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = createAttentionItemStore();
    const stores = new Map<string, Store>([[ORG, store]]);
    const { service } = buildService(
      { [ORG]: [load({ id: 'bad' }), load({ id: 'good' })] },
      stores,
    );
    // Fail by load identity (not call order) so this stays valid if the
    // sweep's transaction sequence ever changes.
    const realFindUnique = store.findUnique.getMockImplementation()!;
    store.findUnique.mockImplementation(async (args) => {
      if (args.where.organizationId_loadId_type.loadId === 'bad') throw new TypeError('boom');
      return realFindUnique(args);
    });

    await service.run();

    expect(itemsOf(store).map((r) => r.loadId)).toEqual(['good']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('errorType=TypeError'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('recordsFailed=1'));
    // never leaks the raw error message
    for (const call of errorSpy.mock.calls) expect(String(call[0])).not.toContain('boom');

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
