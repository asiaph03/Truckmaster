import { ReportCatalogService } from './report-catalog.service';
import { ValidationError } from '../../../common/errors/app-error';

const ORG_ID = 'org-1';

function buildService(txOverrides: Record<string, unknown> = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    adjustment: { findMany: jest.fn().mockResolvedValue([]) },
    load: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    carrierSourcingAttempt: { groupBy: jest.fn().mockResolvedValue([]) },
    carrier: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    quote: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    ...txOverrides,
  };
  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const service = new ReportCatalogService(prisma as never);
  return { service, tx };
}

describe('ReportCatalogService.catalog — role-driven visibility, no client-side mapping', () => {
  it('Admin sees every category', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['ADMIN']);
    expect(categories.map((c) => c.key)).toEqual([
      'AR_AP',
      'FINANCIAL',
      'OPERATIONS',
      'CARRIER_PERFORMANCE',
      'SALES',
    ]);
  });

  it('Dispatcher sees only Operations and Carrier Performance', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['DISPATCHER']);
    expect(categories.map((c) => c.key)).toEqual(['OPERATIONS', 'CARRIER_PERFORMANCE']);
  });

  it('Sales/Booking sees only Sales', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['SALES_BOOKING']);
    expect(categories.map((c) => c.key)).toEqual(['SALES']);
  });

  it('Accounting sees AR/AP, Financial, and Carrier Performance', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['ACCOUNTING']);
    expect(categories.map((c) => c.key)).toEqual(['AR_AP', 'FINANCIAL', 'CARRIER_PERFORMANCE']);
  });

  it('Compliance Reviewer sees nothing', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['COMPLIANCE_REVIEWER']);
    expect(categories).toEqual([]);
  });

  it('AR Aging / AP Aging cards carry an externalPath to the existing Billing routes', () => {
    const { service } = buildService();
    const { categories } = service.catalog(['ADMIN']);
    const arAp = categories.find((c) => c.key === 'AR_AP')!;
    expect(arAp.reports.find((r) => r.id === 'ar-aging')?.externalPath).toBe('/billing/ar-aging');
    expect(arAp.reports.find((r) => r.id === 'ap-aging')?.externalPath).toBe('/billing/ap-aging');
  });
});

describe('ReportCatalogService.paymentHistory', () => {
  it('requires both dateFrom and dateTo', async () => {
    const { service } = buildService();
    await expect(
      service.paymentHistory(ORG_ID, {}, { page: 1, pageSize: 50 }),
    ).rejects.toThrow(ValidationError);
  });

  it('merges Payment and Adjustment rows sorted by date descending', async () => {
    const { service } = buildService({
      payment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'pay-1',
            invoiceId: 'inv-1',
            invoice: { invoiceNumber: 'INV-000001', customerId: 'cust-1', customer: { legalName: 'Acme' } },
            amount: '100.00',
            paymentDate: new Date('2026-01-10'),
            method: 'ACH',
            referenceNumber: 'REF-1',
            recordedBy: { name: 'Jane' },
          },
        ]),
      },
      adjustment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'adj-1',
            invoiceId: 'inv-2',
            invoice: { invoiceNumber: 'INV-000002', customerId: 'cust-2', customer: { legalName: 'Beta' } },
            amount: '50.00',
            adjustmentDate: new Date('2026-01-15'),
            type: 'CREDIT',
            reason: 'Billing dispute',
            createdBy: { name: 'John' },
          },
        ]),
      },
    });

    const result = await service.paymentHistory(
      ORG_ID,
      { dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      { page: 1, pageSize: 50 },
    );

    expect(result.total).toBe(2);
    expect(result.items[0].id).toBe('adj-1'); // later date first
    expect(result.items[1].id).toBe('pay-1');
    expect(result.items[0].type).toBe('ADJUSTMENT');
    expect(result.items[0].adjustmentType).toBe('CREDIT');
    expect(result.items[1].type).toBe('PAYMENT');
    expect(result.items[1].method).toBe('ACH');
    expect(result.truncated).toBe(false);
  });

  it('flags truncated when a source hits the defensive cap', async () => {
    const cappedPayments = Array.from({ length: 2000 }, (_, i) => ({
      id: `pay-${i}`,
      invoiceId: 'inv-1',
      invoice: { invoiceNumber: 'INV-1', customerId: 'cust-1', customer: { legalName: 'Acme' } },
      amount: '10.00',
      paymentDate: new Date('2026-01-10'),
      method: 'ACH',
      referenceNumber: null,
      recordedBy: { name: 'Jane' },
    }));
    const { service } = buildService({
      payment: { findMany: jest.fn().mockResolvedValue(cappedPayments) },
    });

    const result = await service.paymentHistory(
      ORG_ID,
      { dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      { page: 1, pageSize: 50 },
    );

    expect(result.truncated).toBe(true);
  });
});

describe('ReportCatalogService.revenueMargin', () => {
  it('rejects an invalid groupBy before touching the database', async () => {
    const { service, tx } = buildService();
    await expect(
      service.revenueMargin(ORG_ID, 'BOGUS', {}, { page: 1, pageSize: 50 }, false),
    ).rejects.toThrow(ValidationError);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['CUSTOMER', 'CARRIER', 'LANE', 'MONTH'])(
    'accepts groupBy=%s and issues exactly one raw SQL rollup query',
    async (groupBy) => {
      const { service, tx } = buildService();
      await service.revenueMargin(ORG_ID, groupBy, {}, { page: 1, pageSize: 50 }, false);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    },
  );

  it('computes Gross Profit and Margin % per DATABASE_DESIGN.md §20 exactly', async () => {
    const { service } = buildService({
      $queryRaw: jest.fn().mockResolvedValue([
        { group_key: 'cust-1', group_label: 'Acme Freight', load_count: 2, revenue: '2000.00', cost: '1500.00' },
      ]),
    });

    const result = await service.revenueMargin(
      ORG_ID,
      'CUSTOMER',
      {},
      { page: 1, pageSize: 50 },
      false,
    );

    expect(result.items[0]).toMatchObject({
      groupKey: 'cust-1',
      groupLabel: 'Acme Freight',
      loadCount: 2,
      revenue: '2000.00',
      cost: '1500.00',
      grossProfit: '500.00',
      marginPercent: '25.00',
    });
  });

  it('guards divide-by-zero when revenue is 0', async () => {
    const { service } = buildService({
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ group_key: 'cust-1', group_label: 'Acme', load_count: 1, revenue: '0', cost: '0' }]),
    });

    const result = await service.revenueMargin(ORG_ID, 'CUSTOMER', {}, { page: 1, pageSize: 50 }, false);
    expect(result.items[0].marginPercent).toBe('0.00');
  });

  it('runs the rollup twice and returns previousPeriod when compare=true and a date range is given', async () => {
    const { service, tx } = buildService({
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ group_key: 'cust-1', group_label: 'Acme', load_count: 1, revenue: '100', cost: '50' }]),
    });

    const result = await service.revenueMargin(
      ORG_ID,
      'CUSTOMER',
      { dateFrom: '2026-02-01', dateTo: '2026-02-28' },
      { page: 1, pageSize: 50 },
      true,
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(result.previousPeriod).toBeDefined();
    expect(result.previousPeriod?.[0].revenue).toBe('100.00');
  });

  it('does not run a second query when compare=true but no date range is given', async () => {
    const { service, tx } = buildService();
    const result = await service.revenueMargin(ORG_ID, 'CUSTOMER', {}, { page: 1, pageSize: 50 }, true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.previousPeriod).toBeUndefined();
  });
});

describe('ReportCatalogService.loadVolume', () => {
  it('rejects an invalid bucket', async () => {
    const { service } = buildService();
    await expect(
      service.loadVolume(ORG_ID, { bucket: 'YEAR' as never }, { page: 1, pageSize: 50 }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('ReportCatalogService.statusMix', () => {
  it('computes percentOfTotal correctly and sorts by count descending', async () => {
    const { service } = buildService({
      load: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'DELIVERED', _count: 3 },
          { status: 'BOOKED', _count: 1 },
        ]),
      },
    });

    const rows = await service.statusMix(ORG_ID, {});
    expect(rows[0]).toMatchObject({ status: 'DELIVERED', count: 3, percentOfTotal: '75.00' });
    expect(rows[1]).toMatchObject({ status: 'BOOKED', count: 1, percentOfTotal: '25.00' });
  });
});

describe('ReportCatalogService.onTimePerformance', () => {
  it('rejects an invalid groupBy', async () => {
    const { service } = buildService();
    await expect(
      service.onTimePerformance(ORG_ID, 'LOAD', {}, { page: 1, pageSize: 50 }),
    ).rejects.toThrow(ValidationError);
  });

  it('computes on-time % and reports excluded-no-appointment separately', async () => {
    const { service } = buildService({
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          { group_key: 'carrier-1', group_label: 'Eligible Carrier', deliveries_evaluated: 4, on_time_count: 3 },
        ])
        .mockResolvedValueOnce([{ group_key: 'carrier-1', excluded_count: 2 }]),
    });

    const result = await service.onTimePerformance(ORG_ID, 'CARRIER', {}, { page: 1, pageSize: 50 });
    expect(result.items[0]).toMatchObject({
      groupKey: 'carrier-1',
      deliveriesEvaluated: 4,
      onTimeCount: 3,
      onTimePercent: '75.00',
      excludedNoAppointment: 2,
    });
  });
});

describe('ReportCatalogService.carrierPerformance — cost redaction (approved decision)', () => {
  function buildCarrierPerfService() {
    return buildService({
      load: { groupBy: jest.fn().mockResolvedValue([{ assignedCarrierId: 'carrier-1', _count: 5 }]) },
      carrierSourcingAttempt: {
        groupBy: jest.fn().mockResolvedValue([
          { carrierId: 'carrier-1', outcome: 'ASSIGNED', _count: 3 },
          { carrierId: 'carrier-1', outcome: 'DECLINED', _count: 1 },
          { carrierId: 'carrier-1', outcome: 'REJECTED_AFTER_ASSIGNMENT', _count: 1 },
        ]),
      },
      carrier: {
        findMany: jest.fn().mockResolvedValue([{ id: 'carrier-1', legalName: 'Eligible Carrier' }]),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          { group_key: 'carrier-1', group_label: 'Eligible Carrier', deliveries_evaluated: 4, on_time_count: 4 },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { group_key: 'carrier-1', group_label: 'Eligible Carrier', load_count: 5, revenue: '5000', cost: '4000' },
        ]),
    });
  }

  it('Admin/Accounting/OpsManager see totalCost and avgCostPerLoad', async () => {
    const { service } = buildCarrierPerfService();
    const result = await service.carrierPerformance(ORG_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });
    expect(result.items[0]).toMatchObject({
      carrierId: 'carrier-1',
      carrierLegalName: 'Eligible Carrier',
      loadCount: 5,
      rejectionRatePercent: '40.00',
      onTimePercent: '100.00',
      totalCost: '4000.00',
      avgCostPerLoad: '800.00',
    });
  });

  it('Dispatcher sees every operational column but null cost columns, never the literal "null" downstream', async () => {
    const { service } = buildCarrierPerfService();
    const result = await service.carrierPerformance(ORG_ID, ['DISPATCHER'], {}, { page: 1, pageSize: 50 });
    expect(result.items[0].loadCount).toBe(5);
    expect(result.items[0].rejectionRatePercent).toBe('40.00');
    expect(result.items[0].totalCost).toBeNull();
    expect(result.items[0].avgCostPerLoad).toBeNull();
  });
});

describe('ReportCatalogService.salesPerformance — own-row scoping and GP redaction (approved decision)', () => {
  function buildSalesService() {
    return buildService({
      quote: {
        groupBy: jest.fn().mockResolvedValue([
          { createdByUserId: 'rep-1', _count: 4 },
          { createdByUserId: 'rep-2', _count: 2 },
        ]),
        findMany: jest.fn().mockResolvedValue([
          { id: 'quote-1', createdByUserId: 'rep-1' },
          { id: 'quote-2', createdByUserId: 'rep-2' },
        ]),
      },
      auditLog: {
        findMany: jest.fn().mockResolvedValue([
          { entityId: 'quote-1', action: 'Quote Won — Converted to Load' },
          { entityId: 'quote-2', action: 'Quote Marked Lost' },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { group_key: 'rep-1', group_label: 'Jane Rep', load_count: 3, revenue: '3000', cost: '2000' },
        { group_key: 'rep-2', group_label: 'John Rep', load_count: 1, revenue: '1000', cost: '900' },
      ]),
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'rep-1', name: 'Jane Rep' },
          { id: 'rep-2', name: 'John Rep' },
        ]),
      },
    });
  }

  it('Admin sees every rep, including Gross Profit', async () => {
    const { service } = buildSalesService();
    const result = await service.salesPerformance(ORG_ID, 'admin-1', ['ADMIN'], {}, { page: 1, pageSize: 50 });
    expect(result.total).toBe(2);
    const rep1 = result.items.find((r) => r.repUserId === 'rep-1')!;
    expect(rep1).toMatchObject({ quotesCreated: 4, won: 1, lost: 0, winRatePercent: '100.00', revenue: '3000.00', grossProfit: '1000.00' });
  });

  it("Sales/Booking sees only their own row, with grossProfit nulled even on it (never enough to derive carrier cost)", async () => {
    const { service } = buildSalesService();
    const result = await service.salesPerformance(
      ORG_ID,
      'rep-1',
      ['SALES_BOOKING'],
      {},
      { page: 1, pageSize: 50 },
    );
    expect(result.total).toBe(1);
    expect(result.items[0].repUserId).toBe('rep-1');
    expect(result.items[0].revenue).toBe('3000.00');
    expect(result.items[0].grossProfit).toBeNull();
  });
});
