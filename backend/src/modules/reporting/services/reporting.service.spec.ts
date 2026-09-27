import { ReportingService } from './reporting.service';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  return daysAgo(-n);
}

function buildService(
  opts: {
    loads?: Record<string, unknown>[];
    customers?: Record<string, unknown>[];
    carriers?: Record<string, unknown>[];
    invoices?: Record<string, unknown>[];
    invoicesForAging?: Record<string, unknown>[];
    loadsForAging?: Record<string, unknown>[];
    quotes?: Record<string, unknown>[];
    auditEvents?: Record<string, unknown>[];
    notificationCount?: number;
    loadCount?: number;
    quoteCount?: number;
    carrierPaymentCount?: number;
    dispatchRecords?: Record<string, unknown>[];
    trucks?: Record<string, unknown>[];
    notifications?: Record<string, unknown>[];
    loadsForNeedsAttention?: Record<string, unknown>[];
    attentionItems?: Record<string, unknown>[];
  } = {},
) {
  const tx = {
    load: {
      findMany: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if ('assignedCarrierId' in where) return Promise.resolve(opts.loadsForAging ?? []);
        if ('id' in where) return Promise.resolve(opts.loadsForNeedsAttention ?? []);
        return Promise.resolve(opts.loads ?? []);
      }),
      count: jest.fn().mockResolvedValue(opts.loadCount ?? 0),
    },
    dispatchRecord: {
      findMany: jest.fn().mockResolvedValue(opts.dispatchRecords ?? []),
    },
    truck: {
      findMany: jest.fn().mockResolvedValue(opts.trucks ?? []),
    },
    customer: {
      findMany: jest.fn().mockResolvedValue(opts.customers ?? []),
    },
    carrier: {
      findMany: jest.fn().mockResolvedValue(opts.carriers ?? []),
    },
    invoice: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'invoiceNumber' in where ? (opts.invoices ?? []) : (opts.invoicesForAging ?? []),
          ),
        ),
    },
    quote: {
      count: jest.fn().mockResolvedValue(opts.quoteCount ?? 0),
      findMany: jest.fn().mockResolvedValue(opts.quotes ?? []),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue(opts.auditEvents ?? []),
    },
    notification: {
      count: jest.fn().mockResolvedValue(opts.notificationCount ?? 0),
      findMany: jest.fn().mockResolvedValue(opts.notifications ?? []),
    },
    attentionItem: {
      findMany: jest.fn().mockResolvedValue(opts.attentionItems ?? []),
    },
    carrierPayment: {
      count: jest.fn().mockResolvedValue(opts.carrierPaymentCount ?? 0),
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const service = new ReportingService(prisma as never);
  return { service, tx, prisma };
}

describe('ReportingService.search — §5.4 / Decision B4', () => {
  it('returns matches from all four entity types', async () => {
    const { service } = buildService({
      loads: [
        {
          id: 'load-1',
          createdByUserId: 'someone',
          customerRate: '1800',
          rateSource: 'MANUAL',
          rateAgreementId: null,
        },
      ],
      customers: [{ id: 'cust-1', legalName: 'Acme' }],
      carriers: [{ id: 'carrier-1', legalName: 'Acme Trucking' }],
    });

    const result = await service.search(ORG_ID, 'acme', USER_ID, ['ADMIN']);

    expect(result.loads).toHaveLength(1);
    expect(result.customers).toHaveLength(1);
    expect(result.carriers).toHaveLength(1);
  });

  it('excludes invoices entirely for a role with no invoice-view access at all', async () => {
    const { service } = buildService({
      invoices: [{ id: 'inv-1', customer: { accountOwnerUserId: null, createdByUserId: 'other' } }],
    });

    const result = await service.search(ORG_ID, 'INV', USER_ID, ['DISPATCHER']);

    expect(result.invoices).toHaveLength(0);
  });

  it('redacts amounts for a non-owned invoice when the caller is Sales/Booking', async () => {
    const { service } = buildService({
      invoices: [
        {
          id: 'inv-1',
          total: '1800.00',
          remainingBalance: '1800.00',
          dueDate: new Date(),
          customer: { accountOwnerUserId: 'someone-else', createdByUserId: 'someone-else' },
        },
      ],
    });

    const result = await service.search(ORG_ID, 'INV', USER_ID, ['SALES_BOOKING']);

    expect(result.invoices[0].total).toBeNull();
  });

  it('shows full amounts for an own-deal invoice when the caller is Sales/Booking', async () => {
    const { service } = buildService({
      invoices: [
        {
          id: 'inv-1',
          total: '1800.00',
          customer: { accountOwnerUserId: USER_ID, createdByUserId: 'someone-else' },
        },
      ],
    });

    const result = await service.search(ORG_ID, 'INV', USER_ID, ['SALES_BOOKING']);

    expect(result.invoices[0].total).toBe('1800.00');
  });
});

describe('ReportingService.arAging — DATABASE_DESIGN.md §21 / Decision 5', () => {
  it('buckets an invoice due today as Current', async () => {
    const { service } = buildService({
      invoicesForAging: [{ id: 'inv-1', remainingBalance: '100.00', dueDate: new Date() }],
    });

    const result = await service.arAging(ORG_ID);

    expect(result.buckets.current.count).toBe(1);
    expect(result.buckets.current.total).toBe('100.00');
  });

  it('buckets exactly-30-days-past-due into 1-30, and 31-days-past-due into 31-60', async () => {
    const { service } = buildService({
      invoicesForAging: [
        { id: 'inv-30', remainingBalance: '50.00', dueDate: daysAgo(30) },
        { id: 'inv-31', remainingBalance: '75.00', dueDate: daysAgo(31) },
      ],
    });

    const result = await service.arAging(ORG_ID);

    expect(result.buckets.days1to30.count).toBe(1);
    expect(result.buckets.days1to30.total).toBe('50.00');
    expect(result.buckets.days31to60.count).toBe(1);
    expect(result.buckets.days31to60.total).toBe('75.00');
  });

  it('buckets 91+ days past due as 90+', async () => {
    const { service } = buildService({
      invoicesForAging: [{ id: 'inv-1', remainingBalance: '200.00', dueDate: daysAgo(91) }],
    });

    const result = await service.arAging(ORG_ID);

    expect(result.buckets.days90plus.count).toBe(1);
    expect(result.grandTotal).toBe('200.00');
  });

  it('an invoice not yet due (future due date) is Current', async () => {
    const { service } = buildService({
      invoicesForAging: [{ id: 'inv-1', remainingBalance: '300.00', dueDate: daysFromNow(10) }],
    });

    const result = await service.arAging(ORG_ID);

    expect(result.buckets.current.count).toBe(1);
  });

  it('Phase 21 — arAgingCsv renders the identical buckets as arAging, plus a Grand Total row', async () => {
    const { service } = buildService({
      invoicesForAging: [{ id: 'inv-1', remainingBalance: '100.00', dueDate: new Date() }],
    });

    const csv = await service.arAgingCsv(ORG_ID);
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Bucket,Items,Total');
    expect(lines).toContain('Current,1,100.00');
    expect(lines[lines.length - 1]).toBe('Grand Total,,100.00');
  });
});

describe('ReportingService.apAging — Decision D14 / disclosed multi-payment interpretation', () => {
  it('buckets outstanding balance by the OLDEST unresolved (non-PAID, submitted) CarrierPayment', async () => {
    const { service } = buildService({
      loadsForAging: [
        {
          id: 'load-1',
          carrierRate: '1500.00',
          carrierPayments: [
            { status: 'PENDING_APPROVAL', amount: '500.00', submittedAt: daysAgo(40) },
            { status: 'PENDING_APPROVAL', amount: '200.00', submittedAt: daysAgo(10) },
          ],
        },
      ],
    });

    const result = await service.apAging(ORG_ID);

    // Outstanding = 1500 - 0(paid) = 1500; anchored on the OLDER submittedAt (40 days ago) -> 31-60 bucket.
    expect(result.buckets.days31to60.count).toBe(1);
    expect(result.buckets.days31to60.total).toBe('1500.00');
  });

  it('subtracts PAID payments from the outstanding balance', async () => {
    const { service } = buildService({
      loadsForAging: [
        {
          id: 'load-1',
          carrierRate: '1500.00',
          carrierPayments: [
            { status: 'PAID', amount: '1000.00', submittedAt: daysAgo(20) },
            { status: 'PENDING_APPROVAL', amount: '500.00', submittedAt: daysAgo(5) },
          ],
        },
      ],
    });

    const result = await service.apAging(ORG_ID);

    expect(result.buckets.days1to30.count).toBe(1);
    expect(result.buckets.days1to30.total).toBe('500.00');
  });

  it('excludes a Load with an outstanding balance but zero CarrierPayment rows (not yet aged, D14)', async () => {
    const { service } = buildService({
      loadsForAging: [{ id: 'load-1', carrierRate: '1500.00', carrierPayments: [] }],
    });

    const result = await service.apAging(ORG_ID);

    expect(result.grandTotal).toBe('0.00');
  });

  it('excludes a Load whose only CarrierPayment rows are still DRAFT (never submitted)', async () => {
    const { service } = buildService({
      loadsForAging: [
        {
          id: 'load-1',
          carrierRate: '1500.00',
          carrierPayments: [{ status: 'DRAFT', amount: '500.00', submittedAt: null }],
        },
      ],
    });

    const result = await service.apAging(ORG_ID);

    expect(result.grandTotal).toBe('0.00');
  });

  it('excludes a Load fully paid off (zero or negative outstanding)', async () => {
    const { service } = buildService({
      loadsForAging: [
        {
          id: 'load-1',
          carrierRate: '1500.00',
          carrierPayments: [{ status: 'PAID', amount: '1500.00', submittedAt: daysAgo(10) }],
        },
      ],
    });

    const result = await service.apAging(ORG_ID);

    expect(result.grandTotal).toBe('0.00');
  });

  it('Phase 21 — apAgingCsv renders the identical buckets as apAging, plus a Grand Total row', async () => {
    const { service } = buildService({
      loadsForAging: [
        {
          id: 'load-1',
          carrierRate: '1500.00',
          carrierPayments: [
            { status: 'PENDING_APPROVAL', amount: '500.00', submittedAt: new Date() },
          ],
        },
      ],
    });

    const csv = await service.apAgingCsv(ORG_ID);
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe('Bucket,Items,Total');
    expect(lines).toContain('Current,1,1500.00');
    expect(lines[lines.length - 1]).toBe('Grand Total,,1500.00');
  });
});

describe('ReportingService.dashboard — PRD §9 / Decision 3', () => {
  it('gives Admin every block, computed org-wide', async () => {
    const { service, tx } = buildService({ loadCount: 3, quoteCount: 2 });

    const result = await service.dashboard(ORG_ID, USER_ID, ['ADMIN']);

    expect(result).toHaveProperty('dispatcher');
    expect(result).toHaveProperty('sales');
    expect(result).toHaveProperty('accounting');
    // Org-wide — no assignedDispatcherId/createdByUserId scoping applied.
    expect(tx.load.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ assignedDispatcherId: USER_ID }),
      }),
    );
  });

  it('gives Dispatcher only their own dispatcher block', async () => {
    const { service } = buildService();

    const result = await service.dashboard(ORG_ID, USER_ID, ['DISPATCHER']);

    expect(result).toHaveProperty('dispatcher');
    expect(result).not.toHaveProperty('sales');
    expect(result).not.toHaveProperty('accounting');
  });

  it('scopes the Sales/Booking win rate to the caller and returns 0 when won+lost=0', async () => {
    const { service } = buildService({ auditEvents: [] });

    const result = await service.dashboard(ORG_ID, USER_ID, ['SALES_BOOKING']);

    expect((result as { sales: { winRate: number } }).sales.winRate).toBe(0);
  });

  it('computes win rate as won / (won + lost) over resolution events in the last 30 days', async () => {
    const { service } = buildService({
      auditEvents: [
        { entityId: 'q-1', action: 'Quote Won — Converted to Load' },
        { entityId: 'q-2', action: 'Quote Marked Lost' },
        { entityId: 'q-3', action: 'Quote Won — Converted to Load' },
      ],
      quotes: [
        { id: 'q-1', status: 'WON' },
        { id: 'q-2', status: 'LOST' },
        { id: 'q-3', status: 'WON' },
      ],
    });

    const result = await service.dashboard(ORG_ID, USER_ID, ['SALES_BOOKING']);

    expect(
      (result as { sales: { winRate: number; wonLast30: number; lostLast30: number } }).sales,
    ).toEqual(expect.objectContaining({ wonLast30: 2, lostLast30: 1, winRate: 2 / 3 }));
  });

  it('gives an empty object to a role with no approved KPI block (e.g. Compliance Reviewer only)', async () => {
    const { service } = buildService();

    const result = await service.dashboard(ORG_ID, USER_ID, ['COMPLIANCE_REVIEWER']);

    expect(result).toEqual({});
  });
});

describe('ReportingService.fleetMap — Dashboard Map Phase', () => {
  const DISPATCH_RECORD = {
    truckNumber: 'T-100',
    driverName: 'Jane Driver',
    sourceTruckId: 'truck-1',
    load: {
      id: 'load-1',
      loadNumber: 'LOAD-000001',
      status: 'IN_TRANSIT',
      riskStatus: 'NORMAL',
      assignedCarrierId: 'carrier-1',
      currentLocationCity: 'St. Louis',
      currentLocationState: 'MO',
      currentLocationDescription: null,
      currentLocationUpdatedAt: new Date('2026-09-25T12:00:00Z'),
      currentEta: new Date('2026-09-26T18:00:00Z'),
      stops: [
        { sequence: 1, stopType: 'PICKUP', stopPurpose: 'STANDARD', city: 'Chicago', state: 'IL' },
        { sequence: 2, stopType: 'DELIVERY', stopPurpose: 'STANDARD', city: 'Dallas', state: 'TX' },
      ],
    },
  };

  it('returns active trucks with their last known location for a full-visibility caller, org-wide', async () => {
    const { service, tx } = buildService({ dispatchRecords: [DISPATCH_RECORD] });

    const result = await service.fleetMap(ORG_ID, USER_ID, ['ADMIN']);

    expect(result.activeTrucks).toHaveLength(1);
    expect(result.activeTrucks[0]).toEqual(
      expect.objectContaining({
        truckNumber: 'T-100',
        driverName: 'Jane Driver',
        loadNumber: 'LOAD-000001',
        lastKnownLocation: expect.objectContaining({ city: 'St. Louis', state: 'MO' }),
      }),
    );
    expect(tx.dispatchRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          load: expect.not.objectContaining({ assignedDispatcherId: USER_ID }),
        }),
      }),
    );
  });

  it('scopes active trucks to the caller’s own assigned loads for a Dispatcher', async () => {
    const { service, tx } = buildService({ dispatchRecords: [DISPATCH_RECORD] });

    await service.fleetMap(ORG_ID, USER_ID, ['DISPATCHER']);

    expect(tx.dispatchRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          load: expect.objectContaining({ assignedDispatcherId: USER_ID }),
        }),
      }),
    );
  });

  it('returns null lastKnownLocation — never a guessed location — when no Check Call has been logged', async () => {
    const { service } = buildService({
      dispatchRecords: [
        {
          ...DISPATCH_RECORD,
          load: {
            ...DISPATCH_RECORD.load,
            currentLocationCity: null,
            currentLocationState: null,
          },
        },
      ],
    });

    const result = await service.fleetMap(ORG_ID, USER_ID, ['ADMIN']);

    expect(result.activeTrucks[0].lastKnownLocation).toBeNull();
  });

  it('includes available (undispatched) trucks only for a full-visibility caller', async () => {
    const { service } = buildService({
      dispatchRecords: [DISPATCH_RECORD],
      trucks: [
        {
          id: 'truck-2',
          unitNumber: 'T-200',
          carrierId: 'carrier-2',
          carrier: { legalName: 'Nurana LLC' },
        },
      ],
    });

    const adminResult = await service.fleetMap(ORG_ID, USER_ID, ['ADMIN']);
    expect(adminResult.availableTrucks).toEqual([
      {
        truckId: 'truck-2',
        unitNumber: 'T-200',
        carrierId: 'carrier-2',
        carrierLegalName: 'Nurana LLC',
      },
    ]);

    const dispatcherResult = await service.fleetMap(ORG_ID, USER_ID, ['DISPATCHER']);
    expect(dispatcherResult.availableTrucks).toEqual([]);
  });

  it('excludes a currently-dispatched truck from the available list', async () => {
    const { service, tx } = buildService({
      dispatchRecords: [DISPATCH_RECORD],
      trucks: [{ id: 'truck-2', unitNumber: 'T-200', carrier: { legalName: 'Nurana LLC' } }],
    });

    await service.fleetMap(ORG_ID, USER_ID, ['ADMIN']);

    expect(tx.truck.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ['truck-1'] } }),
      }),
    );
  });

  it('gives an empty result to a role with no approved fleet-map visibility', async () => {
    const { service } = buildService({ dispatchRecords: [DISPATCH_RECORD] });

    const result = await service.fleetMap(ORG_ID, USER_ID, ['COMPLIANCE_REVIEWER']);

    expect(result).toEqual({ activeTrucks: [], availableTrucks: [] });
  });
});

describe('ReportingService.needsAttention — B.5 combined Notification + AttentionItem source', () => {
  const NOTIFICATION = {
    id: 'notif-1',
    type: 'CHECK_CALL_OVERDUE',
    message: 'Check call overdue for LOAD-000001',
    relatedEntityType: 'Load',
    relatedEntityId: 'load-1',
    createdAt: new Date('2026-09-26T10:00:00Z'),
  };

  function attentionItem(overrides: Record<string, unknown> = {}) {
    return {
      id: 'attn-1',
      loadId: 'load-2',
      type: 'STALE_LOCATION',
      severity: 'HIGH',
      status: 'ACTIVE',
      title: 'Stale Location',
      reason: 'Location has not been updated in approximately 3h 5m.',
      impact: null,
      suggestedActions: [{ type: 'VIEW_LOAD' }],
      metadata: { ageMinutes: 185 },
      detectedAt: new Date('2026-09-27T08:00:00Z'),
      updatedAt: new Date('2026-09-27T08:00:00Z'),
      resolvedAt: null,
      ...overrides,
    };
  }

  const LOAD_1 = { id: 'load-1', loadNumber: 'LOAD-000001' };
  const LOAD_2 = { id: 'load-2', loadNumber: 'LOAD-000002' };

  it('1. gives ADMIN organization-wide visibility across both sources', async () => {
    const { service, tx } = buildService({
      notifications: [NOTIFICATION],
      attentionItems: [attentionItem()],
      loadsForNeedsAttention: [LOAD_1, LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items).toHaveLength(2);
    expect(tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ recipientUserId: USER_ID }) }),
    );
    expect(tx.attentionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ load: expect.anything() }) }),
    );
  });

  it('2. gives OPERATIONS_MANAGER the same organization-wide visibility as ADMIN', async () => {
    const { service, tx } = buildService({
      notifications: [NOTIFICATION],
      attentionItems: [attentionItem()],
      loadsForNeedsAttention: [LOAD_1, LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['OPERATIONS_MANAGER'], 1, 25);

    expect(result.items).toHaveLength(2);
    expect(tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ recipientUserId: USER_ID }) }),
    );
    expect(tx.attentionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ load: expect.anything() }) }),
    );
  });

  it('3. scopes a DISPATCHER to AttentionItems whose Load is assigned to them — a different mechanism from Notification.recipientUserId', async () => {
    const { service, tx } = buildService({
      notifications: [],
      attentionItems: [attentionItem()],
      loadsForNeedsAttention: [LOAD_2],
    });

    await service.needsAttention(ORG_ID, USER_ID, ['DISPATCHER'], 1, 25);

    expect(tx.attentionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ load: { assignedDispatcherId: USER_ID } }),
      }),
    );
    // Legacy Notification scoping is retained unchanged, not reused for AttentionItem.
    expect(tx.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ recipientUserId: USER_ID }) }),
    );
  });

  it('4. returns no items for unsupported roles', async () => {
    for (const role of ['SALES_BOOKING', 'ACCOUNTING', 'COMPLIANCE_REVIEWER'] as const) {
      const { service, prisma } = buildService({});
      const result = await service.needsAttention(ORG_ID, USER_ID, [role], 1, 25);
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
      expect(prisma.withTenantTransaction).not.toHaveBeenCalled();
    }
  });

  it('5. scopes every query through withTenantTransaction for the caller’s own organization', async () => {
    const { service, prisma } = buildService({
      attentionItems: [attentionItem()],
      loadsForNeedsAttention: [LOAD_2],
    });

    await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(ORG_ID, expect.any(Function));
  });

  it('6. includes ACTIVE AttentionItems in the default view', async () => {
    const { service } = buildService({
      attentionItems: [attentionItem({ status: 'ACTIVE' })],
      loadsForNeedsAttention: [LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items).toEqual([
      expect.objectContaining({ source: 'ATTENTION_ITEM', status: 'ACTIVE' }),
    ]);
  });

  it('7. excludes RESOLVED AttentionItems by construction — the query itself only ever requests status: ACTIVE', async () => {
    const { service, tx } = buildService({});

    await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(tx.attentionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('8. still surfaces all three legacy Notification signals, each mapped to its documented severity', async () => {
    const overdue = { ...NOTIFICATION, id: 'n-overdue', type: 'CHECK_CALL_OVERDUE' };
    const late = { ...NOTIFICATION, id: 'n-late', type: 'LOAD_LATE' };
    const dueSoon = { ...NOTIFICATION, id: 'n-due-soon', type: 'CHECK_CALL_DUE_SOON' };
    const { service } = buildService({
      notifications: [overdue, late, dueSoon],
      loadsForNeedsAttention: [LOAD_1],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'n-overdue', severity: 'HIGH' }),
        expect.objectContaining({ id: 'n-late', severity: 'HIGH' }),
        expect.objectContaining({ id: 'n-due-soon', severity: 'MEDIUM' }),
      ]),
    );
  });

  it('9. Notification and AttentionItem items coexist in one combined list', async () => {
    const { service } = buildService({
      notifications: [NOTIFICATION],
      attentionItems: [attentionItem()],
      loadsForNeedsAttention: [LOAD_1, LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items.map((i) => i.source).sort()).toEqual(['ATTENTION_ITEM', 'NOTIFICATION']);
  });

  it('10. sorts by severity descending: CRITICAL > HIGH > MEDIUM > INFO', async () => {
    const sameTime = new Date('2026-09-27T08:00:00Z');
    const { service } = buildService({
      attentionItems: [
        attentionItem({
          id: 'a-medium',
          loadId: 'load-2',
          severity: 'MEDIUM',
          detectedAt: sameTime,
        }),
        attentionItem({
          id: 'a-critical',
          loadId: 'load-2',
          severity: 'CRITICAL',
          detectedAt: sameTime,
        }),
        attentionItem({ id: 'a-info', loadId: 'load-2', severity: 'INFO', detectedAt: sameTime }),
        attentionItem({ id: 'a-high', loadId: 'load-2', severity: 'HIGH', detectedAt: sameTime }),
      ],
      loadsForNeedsAttention: [LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items.map((i) => i.id)).toEqual(['a-critical', 'a-high', 'a-medium', 'a-info']);
  });

  it('11. within the same severity, sorts most-recent first', async () => {
    const { service } = buildService({
      attentionItems: [
        attentionItem({
          id: 'a-older',
          loadId: 'load-2',
          severity: 'HIGH',
          detectedAt: new Date('2026-09-27T06:00:00Z'),
        }),
        attentionItem({
          id: 'a-newer',
          loadId: 'load-2',
          severity: 'HIGH',
          detectedAt: new Date('2026-09-27T08:00:00Z'),
        }),
      ],
      loadsForNeedsAttention: [LOAD_2],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items.map((i) => i.id)).toEqual(['a-newer', 'a-older']);
  });

  it('12. paginates the combined, sorted list', async () => {
    const sameTime = new Date('2026-09-27T08:00:00Z');
    const items = ['a', 'b', 'c', 'd', 'e'].map((letter, index) =>
      attentionItem({
        id: `a-${letter}`,
        loadId: 'load-2',
        severity: 'HIGH',
        detectedAt: new Date(sameTime.getTime() - index * 60000),
      }),
    );
    const { service } = buildService({ attentionItems: items, loadsForNeedsAttention: [LOAD_2] });

    const page2 = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 2, 2);

    expect(page2.items.map((i) => i.id)).toEqual(['a-c', 'a-d']);
    expect(page2.page).toBe(2);
    expect(page2.pageSize).toBe(2);
  });

  it('13. reports the full combined total, not the page size', async () => {
    const sameTime = new Date('2026-09-27T08:00:00Z');
    const items = ['a', 'b', 'c', 'd', 'e'].map((letter, index) =>
      attentionItem({
        id: `a-${letter}`,
        loadId: 'load-2',
        severity: 'HIGH',
        detectedAt: new Date(sameTime.getTime() - index * 60000),
      }),
    );
    const { service } = buildService({ attentionItems: items, loadsForNeedsAttention: [LOAD_2] });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 2);

    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(2);
  });

  it('14. performs exactly one batched Load lookup across both sources, never one query per item', async () => {
    const { service, tx } = buildService({
      notifications: [NOTIFICATION, { ...NOTIFICATION, id: 'notif-2', relatedEntityId: 'load-2' }],
      attentionItems: [attentionItem({ id: 'attn-2', loadId: 'load-1' })],
      loadsForNeedsAttention: [LOAD_1, LOAD_2],
    });

    await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    const loadLookupCalls = tx.load.findMany.mock.calls.filter(([args]: [{ where: object }]) =>
      Object.prototype.hasOwnProperty.call(args.where, 'id'),
    );
    expect(loadLookupCalls).toHaveLength(1);
    expect(loadLookupCalls[0][0].where.id).toEqual({
      in: expect.arrayContaining(['load-1', 'load-2']),
    });
  });

  it('15. returns an empty, well-shaped result when neither source has anything', async () => {
    const { service } = buildService({});

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('drops a notification whose related Load no longer resolves, rather than showing a broken link', async () => {
    const { service } = buildService({
      notifications: [NOTIFICATION],
      loadsForNeedsAttention: [],
    });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['ADMIN'], 1, 25);

    expect(result.items).toEqual([]);
  });

  it('gives an empty result to a role with no approved visibility', async () => {
    const { service } = buildService({ notifications: [NOTIFICATION] });

    const result = await service.needsAttention(ORG_ID, USER_ID, ['COMPLIANCE_REVIEWER'], 1, 25);

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });
});
