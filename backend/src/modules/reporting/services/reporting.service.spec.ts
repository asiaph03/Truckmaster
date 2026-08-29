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
  } = {},
) {
  const tx = {
    load: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'assignedCarrierId' in where ? (opts.loadsForAging ?? []) : (opts.loads ?? []),
          ),
        ),
      count: jest.fn().mockResolvedValue(opts.loadCount ?? 0),
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
