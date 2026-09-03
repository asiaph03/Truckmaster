import { Prisma } from '@prisma/client';
import { LoadDraftService } from './load-draft.service';
import { NotFoundError } from '../../../common/errors/app-error';
import { AnthropicRateConfirmationExtractor } from '../../rate-confirmation-extraction/services/anthropic-rate-confirmation-extractor';
import { RateConfirmationExtractionWorker } from '../../rate-confirmation-extraction/services/rate-confirmation-extraction.worker';
import type { ExtractedRateConfirmationData } from '../../rate-confirmation-extraction/rate-confirmation-extractor.interface';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';
const USER_ID = 'user-1';
const CUSTOMER_ID = 'customer-1';
const EXTRACTION_ID = 'extraction-1';
const DOCUMENT_ID = 'doc-1';

const SAMPLE_EXTRACTION: ExtractedRateConfirmationData = {
  customer: {
    extractedName: 'Basciani Express',
    billingAddressLine1: '1 Main St',
    billingCity: 'Chicago',
    billingState: 'IL',
    billingZip: '60601',
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
  },
  equipmentType: 'DRY_VAN',
  customerRate: '2500.00',
  customerPoNumber: 'PO-1',
  bolNumber: null,
  pickupNumber: null,
  customerReferenceNumber: null,
  stops: [
    {
      stopType: 'PICKUP',
      companyName: 'Shipper Co',
      addressLine1: '10 Dock Rd',
      city: 'Elgin',
      state: 'IL',
      zip: '60120',
      contactName: null,
      contactPhone: null,
      appointmentDatetime: '2026-09-10T08:00',
    },
    {
      stopType: 'DELIVERY',
      companyName: 'Receiver Co',
      addressLine1: '20 Warehouse Ave',
      city: 'Peoria',
      state: 'IL',
      zip: '61602',
      contactName: null,
      contactPhone: null,
      appointmentDatetime: '2026-09-11T12:00',
    },
  ],
  warnings: [],
  unmappedFields: [],
};

function buildDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    organizationId: ORG_ID,
    entityType: 'RATE_CONFIRMATION_INTAKE',
    entityId: EXTRACTION_ID,
    isCurrentVersion: true,
    fileName: 'ratecon.pdf',
    ...overrides,
  };
}

function buildCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    organizationId: ORG_ID,
    legalName: 'Basciani Express',
    status: 'PROSPECT',
    ...overrides,
  };
}

function buildService(
  opts: {
    document?: Record<string, unknown> | null;
    customer?: Record<string, unknown> | null;
    existingDraft?: Record<string, unknown> | null;
  } = {},
) {
  const documentFindFirst = jest
    .fn()
    .mockResolvedValue('document' in opts ? opts.document : buildDocument());
  const customerFindFirst = jest
    .fn()
    .mockResolvedValue('customer' in opts ? opts.customer : buildCustomer());
  const loadDraftFindFirst = jest.fn().mockResolvedValue(opts.existingDraft ?? null);
  const loadDraftCreate = jest.fn().mockImplementation(({ data }) => ({
    id: 'draft-1',
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    updatedAt: new Date('2026-09-04T00:00:00.000Z'),
    ...data,
  }));
  const loadDraftFindMany = jest.fn().mockResolvedValue([]);
  const loadDraftDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const customerFindMany = jest.fn().mockResolvedValue([buildCustomer()]);
  const documentFindMany = jest.fn().mockResolvedValue([buildDocument()]);

  const tx = {
    document: { findFirst: documentFindFirst, findMany: documentFindMany },
    customer: { findFirst: customerFindFirst, findMany: customerFindMany },
    loadDraft: {
      findFirst: loadDraftFindFirst,
      create: loadDraftCreate,
      findMany: loadDraftFindMany,
      deleteMany: loadDraftDeleteMany,
    },
  };

  const prisma = {
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const service = new LoadDraftService(prisma as never);
  return { service, tx, prisma };
}

describe('LoadDraftService.create', () => {
  it('creates a draft snapshotting the extraction result against the existing Document and Customer', async () => {
    const { service, tx } = buildService();

    const result = await service.create(ORG_ID, USER_ID, {
      extractionId: EXTRACTION_ID,
      customerId: CUSTOMER_ID,
      extractedData: SAMPLE_EXTRACTION,
    } as never);

    expect(tx.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          entityType: 'RATE_CONFIRMATION_INTAKE',
          entityId: EXTRACTION_ID,
        }),
      }),
    );
    expect(tx.loadDraft.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          createdByUserId: USER_ID,
          customerId: CUSTOMER_ID,
          rateConfirmationDocumentId: DOCUMENT_ID,
          extractedData: SAMPLE_EXTRACTION,
        }),
      }),
    );
    expect(result.rateConfirmationDocumentId).toBe(DOCUMENT_ID);
    expect(result.customerLegalName).toBe('Basciani Express');
    expect(result.extractedData).toEqual(SAMPLE_EXTRACTION);
  });

  it('throws NotFoundError when the source Document does not exist in this org', async () => {
    const { service } = buildService({ document: null });

    await expect(
      service.create(ORG_ID, USER_ID, {
        extractionId: EXTRACTION_ID,
        customerId: CUSTOMER_ID,
        extractedData: SAMPLE_EXTRACTION,
      } as never),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when the Customer does not exist in this org', async () => {
    const { service } = buildService({ customer: null });

    await expect(
      service.create(ORG_ID, USER_ID, {
        extractionId: EXTRACTION_ID,
        customerId: CUSTOMER_ID,
        extractedData: SAMPLE_EXTRACTION,
      } as never),
    ).rejects.toThrow(NotFoundError);
  });

  it('is idempotent — a second create() for the same source Document returns the existing draft, never a duplicate', async () => {
    const existingDraft = {
      id: 'draft-existing',
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      rateConfirmationDocumentId: DOCUMENT_ID,
      extractedData: SAMPLE_EXTRACTION,
      createdAt: new Date('2026-09-03T00:00:00.000Z'),
    };
    const { service, tx } = buildService({ existingDraft });

    const result = await service.create(ORG_ID, USER_ID, {
      extractionId: EXTRACTION_ID,
      customerId: CUSTOMER_ID,
      extractedData: SAMPLE_EXTRACTION,
    } as never);

    expect(tx.loadDraft.create).not.toHaveBeenCalled();
    expect(result.id).toBe('draft-existing');
  });

  it("a concurrent create() race (two requests pass the initial check before either commits) falls back to the winner's row instead of throwing", async () => {
    const winnerDraft = {
      id: 'draft-winner',
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      rateConfirmationDocumentId: DOCUMENT_ID,
      extractedData: SAMPLE_EXTRACTION,
      createdAt: new Date('2026-09-04T00:00:00.000Z'),
    };
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    const tx = {
      document: { findFirst: jest.fn().mockResolvedValue(buildDocument()) },
      customer: { findFirst: jest.fn().mockResolvedValue(buildCustomer()) },
      loadDraft: {
        // First call (the pre-create idempotency check): nothing exists
        // yet, from THIS request's point of view. Second call (the
        // catch-block fallback, after the concurrent insert lost the
        // race): the other request's row is now there.
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winnerDraft),
        create: jest.fn().mockRejectedValue(p2002),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new LoadDraftService(prisma as never);

    const result = await service.create(ORG_ID, USER_ID, {
      extractionId: EXTRACTION_ID,
      customerId: CUSTOMER_ID,
      extractedData: SAMPLE_EXTRACTION,
    } as never);

    expect(tx.loadDraft.findFirst).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('draft-winner');
  });

  it('re-throws a create() failure that is NOT the expected unique-constraint race', async () => {
    const { service, tx } = buildService();
    tx.loadDraft.create.mockRejectedValue(new Error('some other database error'));

    await expect(
      service.create(ORG_ID, USER_ID, {
        extractionId: EXTRACTION_ID,
        customerId: CUSTOMER_ID,
        extractedData: SAMPLE_EXTRACTION,
      } as never),
    ).rejects.toThrow('some other database error');
  });

  it("only ever resolves the Document/Customer within the caller's own organization (tenant isolation)", async () => {
    const { service, prisma } = buildService();

    await service.create(OTHER_ORG_ID, USER_ID, {
      extractionId: EXTRACTION_ID,
      customerId: CUSTOMER_ID,
      extractedData: SAMPLE_EXTRACTION,
    } as never);

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(OTHER_ORG_ID, expect.any(Function));
  });
});

describe('LoadDraftService.get / list / delete', () => {
  it('get() returns the full snapshot including extractedData and a live customerStatus', async () => {
    const draft = {
      id: 'draft-1',
      organizationId: ORG_ID,
      customerId: CUSTOMER_ID,
      rateConfirmationDocumentId: DOCUMENT_ID,
      extractedData: SAMPLE_EXTRACTION,
      createdAt: new Date('2026-09-04T00:00:00.000Z'),
    };
    const { service, tx } = buildService();
    tx.loadDraft.findFirst.mockResolvedValue(draft);

    const result = await service.get(ORG_ID, 'draft-1');

    expect(result.extractedData).toEqual(SAMPLE_EXTRACTION);
    expect(result.customerStatus).toBe('PROSPECT');
    expect(result.rateConfirmationDocumentId).toBe(DOCUMENT_ID);
  });

  it('get() throws NotFoundError for a draft not owned by this org', async () => {
    const { service, tx } = buildService();
    tx.loadDraft.findFirst.mockResolvedValue(null);

    await expect(service.get(ORG_ID, 'nope')).rejects.toThrow(NotFoundError);
  });

  it('list() returns an empty array when there are no drafts', async () => {
    const { service } = buildService();

    const result = await service.list(ORG_ID);
    expect(result).toEqual([]);
  });

  it('delete() is idempotent — never throws for an already-gone draft', async () => {
    const { service, tx } = buildService();
    tx.loadDraft.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.delete(ORG_ID, 'nonexistent')).resolves.toBeUndefined();
  });
});

/**
 * NON-NEGOTIABLE regression (explicitly required): a Rate Confirmation
 * must be sent to the extractor at most once. Resuming a LoadDraft —
 * even long after the Redis extraction job (1-hour TTL) would have
 * expired — must restore every extracted field WITHOUT invoking the
 * Anthropic extractor or the extraction worker again, and must keep
 * pointing at the exact same Document.
 */
describe('LoadDraftService — credit-saving regression: resuming a draft never re-extracts', () => {
  it('create() then get() restores all fields, touches the same Document id, and never calls the Anthropic extractor or the extraction worker', async () => {
    const extractSpy = jest
      .spyOn(AnthropicRateConfirmationExtractor.prototype, 'extract')
      .mockImplementation(() => {
        throw new Error('MUST NOT be called — extraction must happen at most once.');
      });
    // processJob is private; spying via the prototype still proves the
    // worker's own job-processing entry point was never invoked, without
    // needing to construct a real Worker/Redis-backed instance.
    const processJobSpy = jest
      .spyOn(RateConfirmationExtractionWorker.prototype as never, 'processJob')
      .mockImplementation(() => {
        throw new Error('MUST NOT be called — resuming a draft must never re-run extraction.');
      });

    // Self-contained, stateful mock (not the shared buildService() helper)
    // so create() followed by get() behaves like a real database: the
    // draft created in step 1 is what step 3's lookup actually finds.
    let persistedDraft: Record<string, unknown> | null = null;
    const tx = {
      document: { findFirst: jest.fn().mockResolvedValue(buildDocument()) },
      customer: { findFirst: jest.fn().mockResolvedValue(buildCustomer()) },
      loadDraft: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
          if (!persistedDraft) return Promise.resolve(null);
          if (where.id && where.id !== persistedDraft.id) return Promise.resolve(null);
          return Promise.resolve(persistedDraft);
        }),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          persistedDraft = {
            id: 'draft-1',
            createdAt: new Date('2026-09-04T00:00:00.000Z'),
            updatedAt: new Date('2026-09-04T00:00:00.000Z'),
            ...data,
          };
          return persistedDraft;
        }),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new LoadDraftService(prisma as never);

    // 1. Extraction already completed elsewhere (this is what a real
    //    extraction run would have produced) — create the draft.
    const created = await service.create(ORG_ID, USER_ID, {
      extractionId: EXTRACTION_ID,
      customerId: CUSTOMER_ID,
      extractedData: SAMPLE_EXTRACTION,
    } as never);

    // 2. Simulate the Redis extraction job no longer being available
    //    (1-hour TTL expired, or Redis flushed). LoadDraftService never
    //    holds a reference to RateConfirmationExtractionJobStore/Redis at
    //    all — there is nothing to "expire" from this service's point of
    //    view, which is exactly the point: it never depended on it past
    //    the initial snapshot.
    expect(service).not.toHaveProperty('jobStore');
    expect(service).not.toHaveProperty('extractor');

    // 3. Resume — fetch the draft as the New Load page would on reload.
    const resumed = await service.get(ORG_ID, created.id);

    // 4. Every extracted field is restored exactly.
    expect(resumed.extractedData).toEqual(SAMPLE_EXTRACTION);
    expect(resumed.extractedData.customer?.extractedName).toBe('Basciani Express');
    expect(resumed.extractedData.stops).toHaveLength(2);
    expect(resumed.extractedData.stops[0].companyName).toBe('Shipper Co');
    expect(resumed.extractedData.stops[1].companyName).toBe('Receiver Co');

    // 5. Still the exact same source Document — never re-uploaded, never duplicated.
    expect(resumed.rateConfirmationDocumentId).toBe(DOCUMENT_ID);
    expect(created.rateConfirmationDocumentId).toBe(resumed.rateConfirmationDocumentId);

    // 6. Zero Anthropic calls, zero worker job processing, across the whole flow.
    expect(extractSpy).not.toHaveBeenCalled();
    expect(processJobSpy).not.toHaveBeenCalled();

    extractSpy.mockRestore();
    processJobSpy.mockRestore();
  });
});
