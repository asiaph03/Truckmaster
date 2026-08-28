import { DocumentSearchService } from './document-search.service';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    fileName: 'file.pdf',
    documentType: { label: 'Bill of Lading' },
    entityType: 'LOAD',
    entityId: 'load-1',
    scanStatus: 'CLEAN',
    reviewStatus: null,
    generationStatus: null,
    uploadedBy: { name: 'Jane Doe' },
    uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildService(overrides: Record<string, Record<string, jest.Mock>> = {}) {
  const empty = (fn?: jest.Mock) => fn ?? jest.fn().mockResolvedValue([]);
  const tx = {
    document: {
      count: overrides.document?.count ?? jest.fn().mockResolvedValue(0),
      findMany: overrides.document?.findMany ?? jest.fn().mockResolvedValue([]),
    },
    load: { findMany: empty(overrides.load?.findMany) },
    stop: { findMany: empty(overrides.stop?.findMany) },
    customer: { findMany: empty(overrides.customer?.findMany) },
    carrier: { findMany: empty(overrides.carrier?.findMany) },
    driver: { findMany: empty(overrides.driver?.findMany) },
    truck: { findMany: empty(overrides.truck?.findMany) },
    trailer: { findMany: empty(overrides.trailer?.findMany) },
    invoice: { findMany: empty(overrides.invoice?.findMany) },
    carrierPayment: { findMany: empty(overrides.carrierPayment?.findMany) },
  };
  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const service = new DocumentSearchService(prisma as never);
  return { service, tx };
}

describe('DocumentSearchService.search — base filters', () => {
  it('always scopes to the organization and current-version documents', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(tx.document.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: ORG_ID, isCurrentVersion: true }),
    });
  });

  it('applies entityType, documentTypeId, status, and date-range filters directly', async () => {
    const { service, tx } = buildService();

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      {
        entityType: 'CARRIER',
        documentTypeId: 'type-1',
        scanStatus: 'CLEAN',
        reviewStatus: 'APPROVED',
        generationStatus: 'COMPLETED',
        uploadedFrom: '2026-01-01',
        uploadedTo: '2026-01-31',
      },
      { page: 1, pageSize: 50 },
    );

    expect(tx.document.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        entityType: 'CARRIER',
        documentTypeId: 'type-1',
        scanStatus: 'CLEAN',
        reviewStatus: 'APPROVED',
        generationStatus: 'COMPLETED',
        uploadedAt: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') },
      }),
    });
  });

  it('never fetches unbounded rows for pre-queries — every entity lookup is capped', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['ADMIN'], { q: 'acme' }, { page: 1, pageSize: 50 });

    expect(tx.load.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, select: { id: true } }),
    );
    expect(tx.carrier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, select: { id: true } }),
    );
  });
});

describe('DocumentSearchService.search — Tier 1/2 search resolution', () => {
  it('OR-combines direct-field matches with matched owning-entity id lists', async () => {
    const { service, tx } = buildService({
      load: { findMany: jest.fn().mockResolvedValue([{ id: 'load-1' }]) },
    });

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { q: 'LOAD-000001' },
      { page: 1, pageSize: 50 },
    );

    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { fileName: { contains: 'LOAD-000001', mode: 'insensitive' } },
        { entityType: 'LOAD', entityId: { in: ['load-1'] } },
      ]),
    );
  });

  it('resolves STOP (POD) matches through the parent Load result set, not a direct Stop field', async () => {
    const { service, tx } = buildService({
      load: { findMany: jest.fn().mockResolvedValue([{ id: 'load-1' }]) },
      stop: { findMany: jest.fn().mockResolvedValue([{ id: 'stop-1' }]) },
    });

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { q: 'LOAD-000001' },
      { page: 1, pageSize: 50 },
    );

    expect(tx.stop.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID, loadId: { in: ['load-1'] } } }),
    );
    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([{ entityType: 'STOP', entityId: { in: ['stop-1'] } }]),
    );
  });

  it('skips the Stop pre-query entirely when no Load matched the search term', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['ADMIN'], { q: 'nomatch' }, { page: 1, pageSize: 50 });

    expect(tx.stop.findMany).not.toHaveBeenCalled();
  });
});

describe('DocumentSearchService.search — Carrier Payment visibility (FINANCIAL_VIEW_ROLES)', () => {
  it('excludes CARRIER_PAYMENT documents entirely for a Dispatcher', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['DISPATCHER'], {}, { page: 1, pageSize: 50 });

    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.AND).toEqual(expect.arrayContaining([{ entityType: { not: 'CARRIER_PAYMENT' } }]));
  });

  it('excludes CARRIER_PAYMENT documents entirely for Sales/Booking (no ownership carve-out)', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['SALES_BOOKING'], {}, { page: 1, pageSize: 50 });

    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.AND).toEqual(expect.arrayContaining([{ entityType: { not: 'CARRIER_PAYMENT' } }]));
  });

  it.each(['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'])(
    'does not exclude CARRIER_PAYMENT documents for %s',
    async (role) => {
      const { service, tx } = buildService();

      await service.search(ORG_ID, USER_ID, [role as never], {}, { page: 1, pageSize: 50 });

      const where = tx.document.count.mock.calls[0][0].where;
      const and = (where.AND ?? []) as Record<string, unknown>[];
      expect(and).not.toEqual(expect.arrayContaining([{ entityType: { not: 'CARRIER_PAYMENT' } }]));
    },
  );
});

describe('DocumentSearchService.search — Invoice visibility (mirrors InvoiceService.findById)', () => {
  it('excludes INVOICE documents entirely for a pure Dispatcher (matches INVOICE_VIEW_ROLES exclusion)', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['DISPATCHER'], {}, { page: 1, pageSize: 50 });

    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.AND).toEqual(expect.arrayContaining([{ entityType: { not: 'INVOICE' } }]));
    expect(tx.invoice.findMany).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'])(
    'grants full INVOICE visibility for %s, skipping the ownership pre-query',
    async (role) => {
      const { service, tx } = buildService();

      await service.search(ORG_ID, USER_ID, [role as never], {}, { page: 1, pageSize: 50 });

      const where = tx.document.count.mock.calls[0][0].where;
      const and = (where.AND ?? []) as Record<string, unknown>[];
      expect(and).not.toEqual(expect.arrayContaining([{ entityType: { not: 'INVOICE' } }]));
      expect(tx.invoice.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.anything() }) }),
      );
    },
  );

  it('restricts Sales/Booking to own-deal invoices via the parent Customer accountOwnerUserId', async () => {
    const { service, tx } = buildService({
      invoice: { findMany: jest.fn().mockResolvedValue([{ id: 'invoice-owned' }]) },
    });

    await service.search(ORG_ID, USER_ID, ['SALES_BOOKING'], {}, { page: 1, pageSize: 50 });

    expect(tx.invoice.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        OR: [
          { customer: { accountOwnerUserId: USER_ID } },
          { customer: { accountOwnerUserId: null, createdByUserId: USER_ID } },
        ],
      },
      select: { id: true },
    });
    const where = tx.document.count.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { NOT: { entityType: 'INVOICE', entityId: { notIn: ['invoice-owned'] } } },
      ]),
    );
  });
});

describe('DocumentSearchService.search — sort mapping', () => {
  it('defaults to uploadedAt desc', async () => {
    const { service, tx } = buildService();

    await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { uploadedAt: 'desc' } }),
    );
  });

  it('maps documentType sort to the relation label field', async () => {
    const { service, tx } = buildService();

    await service.search(
      ORG_ID,
      USER_ID,
      ['ADMIN'],
      { sort: 'documentType', sortDirection: 'asc' },
      { page: 1, pageSize: 50 },
    );

    expect(tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { documentType: { label: 'asc' } } }),
    );
  });
});

describe('DocumentSearchService.search — entity label/link resolution', () => {
  it('resolves a LOAD document to the load number and its detail link', async () => {
    const { service } = buildService({
      document: {
        findMany: jest.fn().mockResolvedValue([doc({ entityType: 'LOAD', entityId: 'load-1' })]),
      },
      load: {
        findMany: jest.fn().mockResolvedValue([{ id: 'load-1', loadNumber: 'LOAD-000042' }]),
      },
    });

    const result = await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(result.items[0]).toMatchObject({
      entityLabel: 'LOAD-000042',
      entityLinkPath: '/loads/load-1',
    });
  });

  it('resolves a STOP (POD) document to the parent Load, since a Stop has no identity of its own', async () => {
    const { service } = buildService({
      document: {
        findMany: jest.fn().mockResolvedValue([doc({ entityType: 'STOP', entityId: 'stop-1' })]),
      },
      stop: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'stop-1', load: { id: 'load-9', loadNumber: 'LOAD-000009' } }]),
      },
    });

    const result = await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(result.items[0]).toMatchObject({
      entityLabel: 'LOAD-000009',
      entityLinkPath: '/loads/load-9',
    });
  });

  it('resolves a DRIVER document to the driver full name and the parent Carrier link', async () => {
    const { service } = buildService({
      document: {
        findMany: jest
          .fn()
          .mockResolvedValue([doc({ entityType: 'DRIVER', entityId: 'driver-1' })]),
      },
      driver: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'driver-1', firstName: 'John', lastName: 'Smith', carrierId: 'carrier-7' },
          ]),
      },
    });

    const result = await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(result.items[0]).toMatchObject({
      entityLabel: 'John Smith',
      entityLinkPath: '/carriers/carrier-7',
    });
  });

  it('resolves a CARRIER_PAYMENT document, falling back to payment type when there is no reference number', async () => {
    const { service } = buildService({
      document: {
        findMany: jest
          .fn()
          .mockResolvedValue([doc({ entityType: 'CARRIER_PAYMENT', entityId: 'pay-1' })]),
      },
      carrierPayment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'pay-1', paymentType: 'SETTLEMENT', referenceNumber: null }]),
      },
    });

    const result = await service.search(ORG_ID, USER_ID, ['ADMIN'], {}, { page: 1, pageSize: 50 });

    expect(result.items[0]).toMatchObject({
      entityLabel: 'SETTLEMENT',
      entityLinkPath: '/billing/carrier-pay/pay-1',
    });
  });
});

describe('DocumentSearchService.exportCsv', () => {
  it('applies the identical exclusions as search and produces a header + one row per document', async () => {
    const { service, tx } = buildService({
      document: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            doc({ fileName: 'pod.pdf', entityType: 'LOAD', entityId: 'load-1' }),
          ]),
      },
      load: {
        findMany: jest.fn().mockResolvedValue([{ id: 'load-1', loadNumber: 'LOAD-000042' }]),
      },
    });

    const csv = await service.exportCsv(ORG_ID, USER_ID, ['DISPATCHER'], {});

    const where = tx.document.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { entityType: { not: 'CARRIER_PAYMENT' } },
        { entityType: { not: 'INVOICE' } },
      ]),
    );
    expect(csv.split('\r\n')[0]).toBe(
      'File Name,Document Type,Entity Type,Entity Identifier,Scan Status,Review Status,Generation Status,Uploaded By,Uploaded At',
    );
    expect(csv).toContain('pod.pdf,Bill of Lading,LOAD,LOAD-000042');
  });

  it('never paginates — no skip/take passed to the underlying findMany', async () => {
    const { service, tx } = buildService();

    await service.exportCsv(ORG_ID, USER_ID, ['ADMIN'], {});

    const call = tx.document.findMany.mock.calls[0][0];
    expect(call.skip).toBeUndefined();
    expect(call.take).toBeUndefined();
  });
});
