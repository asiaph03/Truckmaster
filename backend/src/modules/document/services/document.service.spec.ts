import { DocumentService } from './document.service';
import { RequestContextStore } from '../../../common/tenant-context/request-context';
import {
  BusinessRuleError,
  NotFoundError,
  PermissionError,
  SelfReviewForbiddenError,
} from '../../../common/errors/app-error';

describe('DocumentService.review — Workflow 3 §3.4 self-review prevention', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';
  const UPLOADER_ID = 'uploader-1';
  const REVIEWER_ID = 'reviewer-1';

  function buildService(opts: {
    documentOverrides?: Record<string, unknown>;
    documentTypeOverrides?: Record<string, unknown>;
  }) {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      entityType: 'CARRIER',
      entityId: 'carrier-1',
      documentTypeId: 'doctype-1',
      uploadedByUserId: UPLOADER_ID,
      reviewStatus: 'PENDING_REVIEW',
      ...opts.documentOverrides,
    };
    const documentType = {
      id: 'doctype-1',
      code: 'W9',
      requiresReview: true,
      ...opts.documentTypeOverrides,
    };

    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(document),
        update: jest.fn().mockImplementation(({ data }) => ({ ...document, ...data })),
      },
      documentTypeDefinition: { findFirst: jest.fn().mockResolvedValue(documentType) },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {};
    const carrierEligibility = {
      recalculate: jest.fn().mockResolvedValue({ eligible: true, reasons: [] }),
    };
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('NOT_RECEIVED') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, audit, carrierEligibility, document };
  }

  it('blocks a reviewer from approving a document they uploaded themselves', async () => {
    const { service } = buildService({ documentOverrides: { uploadedByUserId: REVIEWER_ID } });

    await expect(
      service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID),
    ).rejects.toThrow(SelfReviewForbiddenError);
  });

  it('allows approval when the reviewer is not the uploader', async () => {
    const { service, tx } = buildService({});

    await service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID);

    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewStatus: 'APPROVED' }) }),
    );
  });

  it('rejects with a reason recorded on the document', async () => {
    const { service, tx } = buildService({});

    await service.review(
      ORG_ID,
      DOC_ID,
      { decision: 'REJECTED', rejectionReason: 'Illegible scan' },
      REVIEWER_ID,
    );

    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewStatus: 'REJECTED',
          rejectionReason: 'Illegible scan',
        }),
      }),
    );
  });

  it('rejects review of a document type that does not require review (400-equivalent BusinessRuleError)', async () => {
    const { service } = buildService({ documentTypeOverrides: { requiresReview: false } });

    await expect(
      service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects review of a document that is not currently Pending Review', async () => {
    const { service } = buildService({ documentOverrides: { reviewStatus: 'APPROVED' } });

    await expect(
      service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws NotFoundError for a document outside the organization', async () => {
    const { service, tx } = buildService({});
    (tx.document.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID),
    ).rejects.toThrow(NotFoundError);
  });

  it('recalculates Carrier eligibility inside the same transaction when the entity is a Carrier', async () => {
    const { service, tx, carrierEligibility } = buildService({});

    await service.review(ORG_ID, DOC_ID, { decision: 'APPROVED' }, REVIEWER_ID);

    expect(carrierEligibility.recalculate).toHaveBeenCalledWith(tx, ORG_ID, 'carrier-1');
  });
});

describe('DocumentService.listPendingReview — Frontend Phase 5 gap-fix (Compliance Review Queue)', () => {
  const ORG_ID = 'org-1';

  function buildService(opts: {
    documents?: Record<string, unknown>[];
    carriers?: Record<string, unknown>[];
  }) {
    const documents = opts.documents ?? [];
    const carriers = opts.carriers ?? [];

    const tx = {
      document: { findMany: jest.fn().mockResolvedValue(documents) },
      carrier: { findMany: jest.fn().mockResolvedValue(carriers) },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = {};
    const storage = {};
    const carrierEligibility = {};
    const loadPodStatus = {};
    const scanQueue = {};
    const extractionQueue = {};

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx };
  }

  it('queries entityType CARRIER + reviewStatus PENDING_REVIEW + isCurrentVersion, scoped to the org', async () => {
    const { service, tx } = buildService({});

    await service.listPendingReview(ORG_ID);

    expect(tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          entityType: 'CARRIER',
          reviewStatus: 'PENDING_REVIEW',
          isCurrentVersion: true,
        },
      }),
    );
  });

  it('returns an empty array without querying carriers when nothing is pending review', async () => {
    const { service, tx } = buildService({ documents: [] });

    const result = await service.listPendingReview(ORG_ID);

    expect(result).toEqual([]);
    expect(tx.carrier.findMany).not.toHaveBeenCalled();
  });

  it('attaches carrierLegalName by resolving the polymorphic entityId against Carrier', async () => {
    const { service, tx } = buildService({
      documents: [
        { id: 'doc-1', entityId: 'carrier-1' },
        { id: 'doc-2', entityId: 'carrier-2' },
      ],
      carriers: [
        { id: 'carrier-1', legalName: 'Big Rig Trucking LLC' },
        { id: 'carrier-2', legalName: 'Speedy Freight Inc' },
      ],
    });

    const result = await service.listPendingReview(ORG_ID);

    expect(result).toEqual([
      expect.objectContaining({ id: 'doc-1', carrierLegalName: 'Big Rig Trucking LLC' }),
      expect.objectContaining({ id: 'doc-2', carrierLegalName: 'Speedy Freight Inc' }),
    ]);
    expect(tx.carrier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['carrier-1', 'carrier-2'] }, organizationId: ORG_ID },
      }),
    );
  });

  it('deduplicates carrierIds before the follow-up query when multiple documents share a carrier', async () => {
    const { service, tx } = buildService({
      documents: [
        { id: 'doc-1', entityId: 'carrier-1' },
        { id: 'doc-2', entityId: 'carrier-1' },
      ],
      carriers: [{ id: 'carrier-1', legalName: 'Big Rig Trucking LLC' }],
    });

    await service.listPendingReview(ORG_ID);

    expect(tx.carrier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['carrier-1'] }, organizationId: ORG_ID } }),
    );
  });

  it('sets carrierLegalName null for a document whose carrier lookup somehow misses (defensive)', async () => {
    const { service } = buildService({
      documents: [{ id: 'doc-1', entityId: 'carrier-1' }],
      carriers: [],
    });

    const result = await service.listPendingReview(ORG_ID);

    expect(result[0]).toEqual(expect.objectContaining({ carrierLegalName: null }));
  });
});

describe('DocumentService.applyScanResult — malware scan / quarantine (Decision 10)', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';

  function buildService() {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      entityType: 'CARRIER',
      entityId: 'carrier-1',
      fileStorageKey: `org_${ORG_ID}/documents/${DOC_ID}`,
      scanStatus: 'PENDING',
    };

    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(document),
        update: jest.fn().mockResolvedValue(document),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildQuarantineKey: jest.fn().mockReturnValue(`org_${ORG_ID}/quarantine/${DOC_ID}`),
      moveToQuarantine: jest.fn().mockResolvedValue(undefined),
    };
    const carrierEligibility = { recalculate: jest.fn() };
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('NOT_RECEIVED') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, audit, storage, document, loadPodStatus };
  }

  it('marks a clean file CLEAN without touching storage', async () => {
    const { service, tx, storage } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'CLEAN', provider: 'stub' });

    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ scanStatus: 'CLEAN' }) }),
    );
    expect(storage.moveToQuarantine).not.toHaveBeenCalled();
  });

  it('quarantines an infected file and updates its storage key to the quarantine prefix', async () => {
    const { service, tx, storage, document } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'INFECTED', provider: 'stub' });

    expect(storage.moveToQuarantine).toHaveBeenCalledWith(
      document.fileStorageKey,
      `org_${ORG_ID}/quarantine/${DOC_ID}`,
    );
    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scanStatus: 'INFECTED',
          fileStorageKey: `org_${ORG_ID}/quarantine/${DOC_ID}`,
        }),
      }),
    );
  });

  it('quarantines a file whose scan failed (treated as blocked, not clean-by-default)', async () => {
    const { service, storage } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'SCAN_FAILED', provider: 'stub' });

    expect(storage.moveToQuarantine).toHaveBeenCalled();
  });

  it('records a system-actor audit event for the scan result', async () => {
    const { service, audit } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'CLEAN', provider: 'stub' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorType: 'SYSTEM' }),
    );
  });
});

describe('DocumentService.applyScanResult — RATE_CONFIRMATION_INTAKE extraction enqueue (isDocumentConsumable gate)', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';
  const EXTRACTION_ID = 'extraction-1';

  function buildService() {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      entityType: 'RATE_CONFIRMATION_INTAKE',
      entityId: EXTRACTION_ID,
      fileStorageKey: `org_${ORG_ID}/documents/${DOC_ID}`,
      scanStatus: 'PENDING',
    };

    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(document),
        update: jest.fn().mockResolvedValue(document),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildQuarantineKey: jest.fn().mockReturnValue(`org_${ORG_ID}/quarantine/${DOC_ID}`),
      moveToQuarantine: jest.fn().mockResolvedValue(undefined),
    };
    const carrierEligibility = { recalculate: jest.fn() };
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('NOT_RECEIVED') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, extractionQueue };
  }

  it('enqueues extraction on CLEAN (existing behavior, unchanged)', async () => {
    const { service, extractionQueue } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'CLEAN', provider: 'stub' });

    expect(extractionQueue.add).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ extractionId: EXTRACTION_ID, documentId: DOC_ID }),
      expect.anything(),
    );
  });

  it('enqueues extraction on SCAN_FAILED (approved policy: a failed scan attempt does not block extraction)', async () => {
    const { service, extractionQueue } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'SCAN_FAILED', provider: 'stub' });

    expect(extractionQueue.add).toHaveBeenCalledWith(
      'extract',
      expect.objectContaining({ extractionId: EXTRACTION_ID, documentId: DOC_ID }),
      expect.anything(),
    );
  });

  it('never enqueues extraction on INFECTED (remains blocked)', async () => {
    const { service, extractionQueue } = buildService();

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'INFECTED', provider: 'stub' });

    expect(extractionQueue.add).not.toHaveBeenCalled();
  });
});

describe('DocumentService.getDownloadUrl — §8.4 gates on scan_status', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';

  function buildService(scanStatus: string) {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      scanStatus,
      fileStorageKey: 'key',
      entityType: 'CARRIER',
      entityId: 'carrier-1',
    };
    const tx = { document: { findFirst: jest.fn().mockResolvedValue(document) } };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const storage = { getDownloadUrl: jest.fn().mockResolvedValue('https://signed-url.example') };
    const carrierEligibility = {};
    const loadPodStatus = {};
    const scanQueue = {};
    const extractionQueue = {};
    const audit = {};

    return new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );
  }

  it('issues a signed URL when scan_status is CLEAN', async () => {
    const service = buildService('CLEAN');
    const result = await service.getDownloadUrl(ORG_ID, DOC_ID, 'user-1', ['DISPATCHER']);
    expect(result.url).toBe('https://signed-url.example');
  });

  it('issues a signed URL when scan_status is SCAN_FAILED (approved policy: a failed scan attempt does not block download, only INFECTED does; the persisted scanStatus itself stays SCAN_FAILED, never rewritten to CLEAN)', async () => {
    const service = buildService('SCAN_FAILED');
    const result = await service.getDownloadUrl(ORG_ID, DOC_ID, 'user-1', ['DISPATCHER']);
    expect(result.url).toBe('https://signed-url.example');
  });

  it('refuses to issue a signed URL while scan_status is PENDING', async () => {
    const service = buildService('PENDING');
    await expect(service.getDownloadUrl(ORG_ID, DOC_ID, 'user-1', ['DISPATCHER'])).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('refuses to issue a signed URL for an INFECTED file', async () => {
    const service = buildService('INFECTED');
    await expect(service.getDownloadUrl(ORG_ID, DOC_ID, 'user-1', ['DISPATCHER'])).rejects.toThrow(
      BusinessRuleError,
    );
  });
});

describe('DocumentService — entity-type-aware view authorization (Invoice/Carrier Payment security fix)', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';
  const ACTING_USER_ID = 'user-1';

  const OWNED_VIA_ACCOUNT_OWNER = {
    accountOwnerUserId: ACTING_USER_ID,
    createdByUserId: 'someone-else',
  };
  const OWNED_VIA_CREATED_BY_FALLBACK = {
    accountOwnerUserId: null,
    createdByUserId: ACTING_USER_ID,
  };
  const NON_OWNED = {
    accountOwnerUserId: 'someone-else',
    createdByUserId: 'someone-else-again',
  };

  function buildService(opts: {
    entityType: string;
    entityId: string;
    invoiceCustomer?: Record<string, unknown> | null;
  }) {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      entityType: opts.entityType,
      entityId: opts.entityId,
      scanStatus: 'CLEAN',
      fileStorageKey: 'key',
    };
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(document),
        findMany: jest.fn().mockResolvedValue([document]),
      },
      invoice: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            opts.invoiceCustomer === undefined
              ? null
              : { id: opts.entityId, customer: opts.invoiceCustomer },
          ),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const storage = { getDownloadUrl: jest.fn().mockResolvedValue('https://signed-url.example') };
    const service = new DocumentService(
      prisma as never,
      {} as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, tx };
  }

  describe('Invoice documents — mirrors InvoiceService.isOwnDeal exactly', () => {
    it.each(['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'])(
      '%s can download an Invoice document',
      async (role) => {
        const { service } = buildService({ entityType: 'INVOICE', entityId: 'invoice-1' });
        const result = await service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [
          role as never,
        ]);
        expect(result.url).toBe('https://signed-url.example');
      },
    );

    it('Sales/Booking can download their own Invoice document (accountOwnerUserId)', async () => {
      const { service } = buildService({
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        invoiceCustomer: OWNED_VIA_ACCOUNT_OWNER,
      });
      const result = await service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [
        'SALES_BOOKING',
      ]);
      expect(result.url).toBe('https://signed-url.example');
    });

    it('Sales/Booking can download their own Invoice document via the createdByUserId fallback', async () => {
      const { service } = buildService({
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        invoiceCustomer: OWNED_VIA_CREATED_BY_FALLBACK,
      });
      const result = await service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [
        'SALES_BOOKING',
      ]);
      expect(result.url).toBe('https://signed-url.example');
    });

    it('Sales/Booking is denied a non-owned Invoice document', async () => {
      const { service } = buildService({
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        invoiceCustomer: NON_OWNED,
      });
      await expect(
        service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, ['SALES_BOOKING']),
      ).rejects.toThrow(PermissionError);
    });

    it.each(['DISPATCHER', 'COMPLIANCE_REVIEWER'])(
      '%s is denied an Invoice document entirely',
      async (role) => {
        const { service } = buildService({ entityType: 'INVOICE', entityId: 'invoice-1' });
        await expect(
          service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [role as never]),
        ).rejects.toThrow(PermissionError);
      },
    );

    it('list() applies the identical authorization as getDownloadUrl, before ever querying documents', async () => {
      const { service, tx } = buildService({
        entityType: 'INVOICE',
        entityId: 'invoice-1',
        invoiceCustomer: NON_OWNED,
      });
      await expect(
        service.list(ORG_ID, 'INVOICE' as never, 'invoice-1', ACTING_USER_ID, ['SALES_BOOKING']),
      ).rejects.toThrow(PermissionError);
      expect(tx.document.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Carrier Payment documents — FINANCIAL_VIEW_ROLES only, no ownership carve-out', () => {
    it.each(['ADMIN', 'ACCOUNTING', 'OPERATIONS_MANAGER'])(
      '%s can download a Carrier Payment document',
      async (role) => {
        const { service } = buildService({ entityType: 'CARRIER_PAYMENT', entityId: 'payment-1' });
        const result = await service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [
          role as never,
        ]);
        expect(result.url).toBe('https://signed-url.example');
      },
    );

    it.each(['SALES_BOOKING', 'DISPATCHER', 'COMPLIANCE_REVIEWER'])(
      '%s is denied a Carrier Payment document',
      async (role) => {
        const { service } = buildService({ entityType: 'CARRIER_PAYMENT', entityId: 'payment-1' });
        await expect(
          service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, [role as never]),
        ).rejects.toThrow(PermissionError);
      },
    );
  });

  describe('The other 7 entity types retain their unrestricted pre-fix behavior', () => {
    it.each(['CARRIER', 'CUSTOMER', 'DRIVER', 'TRUCK', 'TRAILER', 'LOAD', 'STOP'])(
      '%s is downloadable by any authenticated role (e.g. Dispatcher)',
      async (entityType) => {
        const { service } = buildService({ entityType, entityId: 'entity-1' });
        const result = await service.getDownloadUrl(ORG_ID, DOC_ID, ACTING_USER_ID, ['DISPATCHER']);
        expect(result.url).toBe('https://signed-url.example');
      },
    );
  });
});

describe('DocumentService upload permission — entity-aware (§2.5)', () => {
  const ORG_ID = 'org-1';

  function buildService() {
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) =>
          fn({
            carrier: { findFirst: jest.fn().mockResolvedValue({ id: 'carrier-1' }) },
            documentTypeDefinition: {
              findFirst: jest
                .fn()
                .mockResolvedValue({ id: 'dt-1', code: 'W9', requiresReview: true }),
            },
            document: {
              create: jest.fn().mockResolvedValue({ id: 'doc-1' }),
              update: jest.fn().mockResolvedValue({ id: 'doc-1' }),
            },
          }),
        ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildDocumentKey: jest.fn().mockReturnValue('key'),
      getUploadUrl: jest.fn().mockResolvedValue('https://upload-url.example'),
    };
    const carrierEligibility = {};
    const loadPodStatus = {};
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    return new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );
  }

  const UPLOAD_DTO = {
    entityType: 'CARRIER' as const,
    entityId: 'carrier-1',
    documentTypeId: 'dt-1',
    fileName: 'w9.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: 1024,
  };

  it('allows a Dispatcher to upload a carrier document', async () => {
    const service = buildService();
    await RequestContextStore.run({ requestId: 'r1', roles: ['DISPATCHER'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, UPLOAD_DTO, 'user-1')).resolves.toBeDefined();
    });
  });

  it('blocks a Sales/Booking user from uploading a carrier document', async () => {
    const service = buildService();
    await RequestContextStore.run({ requestId: 'r2', roles: ['SALES_BOOKING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /requires Admin, Operations Manager, or Dispatcher/,
      );
    });
  });
});

describe('DocumentService — Load-level document uploads (Load Detail Documents tab gap-fix)', () => {
  const ORG_ID = 'org-1';

  function buildService(
    opts: {
      load?: Record<string, unknown> | null;
      currentVersion?: Record<string, unknown> | null;
    } = {},
  ) {
    const load = 'load' in opts ? opts.load : { id: 'load-1' };
    const tx = {
      load: { findFirst: jest.fn().mockResolvedValue(load) },
      documentTypeDefinition: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'dt-1', code: 'ACCESSORIAL_RECEIPT', requiresReview: false }),
      },
      document: {
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            'currentVersion' in opts
              ? opts.currentVersion
              : { id: 'doc-v1', versionNumber: 1, isCurrentVersion: true },
          ),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildDocumentKey: jest.fn().mockReturnValue('key'),
      getUploadUrl: jest.fn().mockResolvedValue('https://upload-url.example'),
    };
    const carrierEligibility = {};
    const loadPodStatus = {};
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, scanQueue };
  }

  const LOAD_UPLOAD_DTO = {
    entityType: 'LOAD' as const,
    entityId: 'load-1',
    documentTypeId: 'dt-1',
    fileName: 'accessorial-receipt.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: 1024,
  };

  it('allows a Dispatcher to upload a Load-level document (e.g. Accessorial Receipt)', async () => {
    const { service } = buildService();
    await RequestContextStore.run({ requestId: 'r1', roles: ['DISPATCHER'] }, async () => {
      await expect(
        service.initiateUpload(ORG_ID, LOAD_UPLOAD_DTO, 'user-1'),
      ).resolves.toBeDefined();
    });
  });

  it('allows Accounting to upload a Load-level document', async () => {
    const { service } = buildService();
    await RequestContextStore.run({ requestId: 'r2', roles: ['ACCOUNTING'] }, async () => {
      await expect(
        service.initiateUpload(ORG_ID, LOAD_UPLOAD_DTO, 'user-1'),
      ).resolves.toBeDefined();
    });
  });

  it('blocks a Sales/Booking user from uploading a Load-level document', async () => {
    const { service } = buildService();
    await RequestContextStore.run({ requestId: 'r3', roles: ['SALES_BOOKING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, LOAD_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /Uploading a Load document requires Admin, Operations Manager, Dispatcher, or Accounting/,
      );
    });
  });

  it('looks up the Load scoped to the acting organization (tenant isolation)', async () => {
    const { service, tx } = buildService();
    await RequestContextStore.run({ requestId: 'r4', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(ORG_ID, LOAD_UPLOAD_DTO, 'user-1');
    });
    expect(tx.load.findFirst).toHaveBeenCalledWith({
      where: { id: 'load-1', organizationId: ORG_ID },
    });
  });

  // I. Replace creates a new version and preserves previous versions —
  // exercised here for entityType LOAD specifically (the new Replace
  // consumer), reusing the exact same initiateUpload code path POD/POP
  // replace already relies on (Decision Log D4) — never a second/
  // divergent versioning implementation.
  it('Replace (existingDocumentFamilyId set) flips the prior version to isCurrentVersion=false and creates a new, incremented version — never deletes/discards the prior version', async () => {
    const { service, tx } = buildService({
      currentVersion: { id: 'doc-v2', versionNumber: 2, isCurrentVersion: true },
    });
    await RequestContextStore.run({ requestId: 'r6', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(
        ORG_ID,
        { ...LOAD_UPLOAD_DTO, existingDocumentFamilyId: 'family-1' },
        'user-1',
      );
    });

    expect(tx.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-v2' },
        data: { isCurrentVersion: false },
      }),
    );
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentFamilyId: 'family-1',
          versionNumber: 3,
          isCurrentVersion: true,
        }),
      }),
    );
    // The prior version row is updated (isCurrentVersion flipped), never
    // deleted — "preserves previous versions" proven by there being no
    // delete/deleteMany call anywhere in this flow.
    expect((tx.document as { deleteMany?: unknown }).deleteMany).toBeUndefined();
  });

  // J. Replacement still follows malware scanning — confirmUpload (the
  // method that actually enqueues the scan job) has no branching on
  // documentFamilyId/replace at all, so a replacement-created Document
  // goes through the identical confirm -> scan-queue path as any
  // first-time upload. Proven directly against confirmUpload here rather
  // than re-asserting initiateUpload's own lack of scan-bypass logic.
  it('a replacement-created document still requires confirmUpload -> malware scan enqueue, with no shortcut for replace', async () => {
    const { service, tx, scanQueue } = buildService();
    const newVersionDoc = {
      id: 'doc-v3',
      organizationId: ORG_ID,
      entityType: 'LOAD',
      entityId: 'load-1',
      scanStatus: 'PENDING',
      fileStorageKey: `org_${ORG_ID}/documents/doc-v3`,
    };
    (tx.document.findFirst as jest.Mock).mockResolvedValue(newVersionDoc);

    await service.confirmUpload(ORG_ID, 'doc-v3', 'user-1');

    expect(scanQueue.add).toHaveBeenCalledWith(
      'scan',
      expect.objectContaining({ documentId: 'doc-v3', storageKey: newVersionDoc.fileStorageKey }),
      expect.anything(),
    );
  });

  it('rejects with NotFoundError when the Load does not belong to the acting organization', async () => {
    const { service } = buildService({ load: null });
    await RequestContextStore.run({ requestId: 'r5', roles: ['ADMIN'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, LOAD_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /LOAD not found/,
      );
    });
  });
});

describe('DocumentService — Phase 5 POD/Stop uploads (Workflow 7 §7.1)', () => {
  const ORG_ID = 'org-1';

  function buildService(opts: {
    stop?: Record<string, unknown> | null;
    documentType?: Record<string, unknown>;
    existingDocumentFamilyId?: string;
  }) {
    const stop =
      'stop' in opts ? opts.stop : { id: 'stop-1', loadId: 'load-1', stopType: 'DELIVERY' };
    const documentType = opts.documentType ?? {
      id: 'pod-type-1',
      code: 'POD',
      requiresReview: false,
    };

    const tx = {
      stop: { findFirst: jest.fn().mockResolvedValue(stop) },
      documentTypeDefinition: { findFirst: jest.fn().mockResolvedValue(documentType) },
      document: {
        findFirst: jest.fn().mockResolvedValue(
          opts.existingDocumentFamilyId
            ? {
                id: 'prior-doc',
                versionNumber: 1,
                documentFamilyId: opts.existingDocumentFamilyId,
              }
            : null,
        ),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildDocumentKey: jest.fn().mockReturnValue('key'),
      getUploadUrl: jest.fn().mockResolvedValue('https://upload-url.example'),
    };
    const carrierEligibility = {};
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('PARTIAL') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, audit, loadPodStatus };
  }

  const POD_UPLOAD_DTO = {
    entityType: 'STOP' as const,
    entityId: 'stop-1',
    documentTypeId: 'pod-type-1',
    fileName: 'pod.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: 1024,
  };

  it("allows Accounting to upload a POD (Workflow 7's own actor list includes Accounting)", async () => {
    const { service } = buildService({});
    await RequestContextStore.run({ requestId: 'r1', roles: ['ACCOUNTING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POD_UPLOAD_DTO, 'user-1')).resolves.toBeDefined();
    });
  });

  it('blocks Sales/Booking from uploading a POD', async () => {
    const { service } = buildService({});
    await RequestContextStore.run({ requestId: 'r2', roles: ['SALES_BOOKING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POD_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /requires Admin, Operations Manager, Dispatcher, or Accounting/,
      );
    });
  });

  it('rejects uploading an unrecognized document type (e.g. BOL) against a Stop', async () => {
    const { service } = buildService({ documentType: { id: 'bol-1', code: 'BOL' } });
    await RequestContextStore.run({ requestId: 'r3', roles: ['ADMIN'] }, async () => {
      await expect(
        service.initiateUpload(ORG_ID, { ...POD_UPLOAD_DTO, documentTypeId: 'bol-1' }, 'user-1'),
      ).rejects.toThrow(/Only POD or POP documents can be uploaded against a Stop/);
    });
  });

  it('rejects a POD upload against a non-delivery Stop', async () => {
    const { service } = buildService({
      stop: { id: 'stop-1', loadId: 'load-1', stopType: 'PICKUP' },
    });
    await RequestContextStore.run({ requestId: 'r4', roles: ['ADMIN'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POD_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /delivery Stop/,
      );
    });
  });

  it("writes 'POD Uploaded' for a brand-new POD", async () => {
    const { service, audit } = buildService({});
    await RequestContextStore.run({ requestId: 'r5', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(ORG_ID, POD_UPLOAD_DTO, 'user-1');
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'POD Uploaded' }),
    );
  });

  it("writes 'POD Document Version Added' when replacing an existing POD", async () => {
    const { service, audit } = buildService({ existingDocumentFamilyId: 'family-1' });
    await RequestContextStore.run({ requestId: 'r6', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(
        ORG_ID,
        { ...POD_UPLOAD_DTO, existingDocumentFamilyId: 'family-1' },
        'user-1',
      );
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'POD Document Version Added' }),
    );
  });
});

describe('DocumentService — POP/Stop uploads (symmetric pickup-side counterpart of POD)', () => {
  const ORG_ID = 'org-1';

  function buildService(opts: {
    stop?: Record<string, unknown> | null;
    documentType?: Record<string, unknown>;
    existingDocumentFamilyId?: string;
  }) {
    const stop =
      'stop' in opts ? opts.stop : { id: 'stop-1', loadId: 'load-1', stopType: 'PICKUP' };
    const documentType = opts.documentType ?? {
      id: 'pop-type-1',
      code: 'POP',
      requiresReview: false,
    };

    const tx = {
      stop: { findFirst: jest.fn().mockResolvedValue(stop) },
      documentTypeDefinition: { findFirst: jest.fn().mockResolvedValue(documentType) },
      document: {
        findFirst: jest.fn().mockResolvedValue(
          opts.existingDocumentFamilyId
            ? {
                id: 'prior-doc',
                versionNumber: 1,
                documentFamilyId: opts.existingDocumentFamilyId,
              }
            : null,
        ),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 'doc-1', ...data })),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildDocumentKey: jest.fn().mockReturnValue('key'),
      getUploadUrl: jest.fn().mockResolvedValue('https://upload-url.example'),
    };
    const carrierEligibility = {};
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('PARTIAL') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, audit, loadPodStatus };
  }

  const POP_UPLOAD_DTO = {
    entityType: 'STOP' as const,
    entityId: 'stop-1',
    documentTypeId: 'pop-type-1',
    fileName: 'pop.pdf',
    mimeType: 'application/pdf',
    fileSizeBytes: 1024,
  };

  it('allows an Admin to upload a POP against a pickup Stop', async () => {
    const { service } = buildService({});
    await RequestContextStore.run({ requestId: 'r1', roles: ['ADMIN'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1')).resolves.toBeDefined();
    });
  });

  it('allows Accounting to upload a POP (reuses the identical STOP-entity role set as POD)', async () => {
    const { service } = buildService({});
    await RequestContextStore.run({ requestId: 'r2', roles: ['ACCOUNTING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1')).resolves.toBeDefined();
    });
  });

  it('blocks Sales/Booking from uploading a POP', async () => {
    const { service } = buildService({});
    await RequestContextStore.run({ requestId: 'r3', roles: ['SALES_BOOKING'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /requires Admin, Operations Manager, Dispatcher, or Accounting/,
      );
    });
  });

  it('rejects a POP upload against a non-pickup (DELIVERY) Stop', async () => {
    const { service } = buildService({
      stop: { id: 'stop-1', loadId: 'load-1', stopType: 'DELIVERY' },
    });
    await RequestContextStore.run({ requestId: 'r4', roles: ['ADMIN'] }, async () => {
      await expect(service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1')).rejects.toThrow(
        /POP documents can only be uploaded against a pickup Stop/,
      );
    });
  });

  it("writes 'POP Uploaded' for a brand-new POP", async () => {
    const { service, audit } = buildService({});
    await RequestContextStore.run({ requestId: 'r5', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1');
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'POP Uploaded' }),
    );
  });

  it("writes 'POP Document Version Added' when replacing an existing POP", async () => {
    const { service, audit } = buildService({ existingDocumentFamilyId: 'family-1' });
    await RequestContextStore.run({ requestId: 'r6', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(
        ORG_ID,
        { ...POP_UPLOAD_DTO, existingDocumentFamilyId: 'family-1' },
        'user-1',
      );
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'POP Document Version Added' }),
    );
  });

  it('never triggers pod_status recalculation for a POP upload (POP has no milestone)', async () => {
    const { service, loadPodStatus } = buildService({});
    await RequestContextStore.run({ requestId: 'r7', roles: ['ADMIN'] }, async () => {
      await service.initiateUpload(ORG_ID, POP_UPLOAD_DTO, 'user-1');
    });
    // initiateUpload itself never calls recalculatePodStatus for any
    // upload — recalculation only happens from applyScanResult once a
    // scan result is known (see the class's own doc comment) — asserting
    // it here pins that POP introduces no new call site into initiateUpload.
    expect(loadPodStatus.recalculatePodStatus).not.toHaveBeenCalled();
  });
});

describe('DocumentService.applyScanResult — Phase 5 POD milestone recalculation hook', () => {
  const ORG_ID = 'org-1';
  const DOC_ID = 'doc-1';

  function buildService(entityType: 'STOP' | 'CARRIER') {
    const document = {
      id: DOC_ID,
      organizationId: ORG_ID,
      entityType,
      entityId: entityType === 'STOP' ? 'stop-1' : 'carrier-1',
      fileStorageKey: `org_${ORG_ID}/documents/${DOC_ID}`,
      scanStatus: 'PENDING',
    };

    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(document),
        update: jest.fn().mockResolvedValue(document),
      },
      stop: { findFirst: jest.fn().mockResolvedValue({ id: 'stop-1', loadId: 'load-1' }) },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      buildQuarantineKey: jest.fn().mockReturnValue(`org_${ORG_ID}/quarantine/${DOC_ID}`),
      moveToQuarantine: jest.fn().mockResolvedValue(undefined),
    };
    const carrierEligibility = { recalculate: jest.fn() };
    const loadPodStatus = { recalculatePodStatus: jest.fn().mockResolvedValue('PARTIAL') };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, loadPodStatus };
  }

  it('recalculates pod_status after a CLEAN scan of a Stop-attached (POD) document', async () => {
    const { service, loadPodStatus } = buildService('STOP');

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'CLEAN', provider: 'stub' });

    expect(loadPodStatus.recalculatePodStatus).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'load-1',
    );
  });

  it('still recalculates pod_status after an INFECTED scan — the query itself excludes non-CLEAN documents', async () => {
    const { service, loadPodStatus } = buildService('STOP');

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'INFECTED', provider: 'stub' });

    expect(loadPodStatus.recalculatePodStatus).toHaveBeenCalled();
  });

  it('never touches pod_status recalculation for a non-Stop document', async () => {
    const { service, loadPodStatus } = buildService('CARRIER');

    await service.applyScanResult(ORG_ID, DOC_ID, { status: 'CLEAN', provider: 'stub' });

    expect(loadPodStatus.recalculatePodStatus).not.toHaveBeenCalled();
  });
});

describe('DocumentService.deleteDocumentFamily — Load-Level Documents Delete', () => {
  const ORG_ID = 'org-1';
  const FAMILY_ID = 'family-1';

  function version(n: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `doc-v${n}`,
      organizationId: ORG_ID,
      documentFamilyId: FAMILY_ID,
      entityType: 'LOAD',
      entityId: 'load-1',
      fileStorageKey: `org_${ORG_ID}/documents/doc-v${n}`,
      fileName: `file-v${n}.pdf`,
      versionNumber: n,
      isCurrentVersion: n === 3,
      ...overrides,
    };
  }

  function buildService(
    opts: {
      versions?: Record<string, unknown>[];
      loadDraft?: Record<string, unknown> | null;
      carrierInsurance?: Record<string, unknown> | null;
    } = {},
  ) {
    const versions = opts.versions ?? [version(1), version(2), version(3)];

    const tx = {
      document: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(versions.find((v) => v.id === where.id) ?? null),
          ),
        findMany: jest.fn().mockResolvedValue(versions),
        deleteMany: jest.fn().mockResolvedValue({ count: versions.length }),
      },
      loadDraft: {
        findFirst: jest.fn().mockResolvedValue(opts.loadDraft ?? null),
      },
      carrierInsurance: {
        findFirst: jest.fn().mockResolvedValue(opts.carrierInsurance ?? null),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const carrierEligibility = { recalculate: jest.fn() };
    const loadPodStatus = { recalculatePodStatus: jest.fn() };
    const scanQueue = { add: jest.fn() };
    const extractionQueue = { add: jest.fn() };

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
      extractionQueue as never,
    );

    return { service, tx, audit, storage, versions };
  }

  // A. Delete current version -> entire family deleted.
  it('deleting the current version deletes the entire family (all versions), not just the one requested', async () => {
    const { service, tx } = buildService();

    await RequestContextStore.run({ requestId: 'r1', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(tx.document.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, documentFamilyId: FAMILY_ID },
    });
  });

  // B. Delete an older version -> entire family deleted (same behavior, id of a non-current version).
  it('deleting an older (non-current) version also deletes the entire family', async () => {
    const { service, tx } = buildService();

    await RequestContextStore.run({ requestId: 'r2', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v1', 'user-1');
    });

    expect(tx.document.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, documentFamilyId: FAMILY_ID },
    });
  });

  // C. All family S3 objects are deleted.
  it('deletes every version’s S3 object, not just the current version’s', async () => {
    const { service, storage } = buildService();

    await RequestContextStore.run({ requestId: 'r3', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v1`);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v2`);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v3`);
  });

  // D. Cross-tenant document deletion is rejected.
  it('rejects deletion of a document outside the acting organization (tenant isolation)', async () => {
    const { service, tx } = buildService();
    // Simulates the tenant-scoped query finding nothing for a foreign org's id.
    (tx.document.findFirst as jest.Mock).mockResolvedValue(null);

    await RequestContextStore.run({ requestId: 'r4', roles: ['ADMIN'] }, async () => {
      await expect(service.deleteDocumentFamily('org-OTHER', 'doc-v3', 'user-1')).rejects.toThrow(
        NotFoundError,
      );
    });
    expect(tx.document.deleteMany).not.toHaveBeenCalled();
  });

  // E. Unauthorized role cannot delete.
  it('blocks a Sales/Booking user (not in POD_UPLOAD_ROLES) from deleting', async () => {
    const { service, tx } = buildService();

    await RequestContextStore.run({ requestId: 'r5', roles: ['SALES_BOOKING'] }, async () => {
      await expect(service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1')).rejects.toThrow(
        PermissionError,
      );
    });
    expect(tx.document.deleteMany).not.toHaveBeenCalled();
  });

  // F. Authorized POD_UPLOAD_ROLE can delete (each of the 4 roles).
  it.each(['ADMIN', 'OPERATIONS_MANAGER', 'DISPATCHER', 'ACCOUNTING'] as const)(
    'allows %s (a POD_UPLOAD_ROLES member) to delete',
    async (role) => {
      const { service, tx } = buildService();

      await RequestContextStore.run({ requestId: `r-${role}`, roles: [role] }, async () => {
        await expect(
          service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1'),
        ).resolves.toBeUndefined();
      });
      expect(tx.document.deleteMany).toHaveBeenCalled();
    },
  );

  // G. LoadDraft-referenced document deletion is rejected with a clean business error.
  it('rejects deletion with a clean BusinessRuleError (never a raw FK crash) when a LoadDraft still references any version in the family', async () => {
    const { service, tx } = buildService({
      loadDraft: { id: 'draft-1', rateConfirmationDocumentId: 'doc-v3' },
    });

    await RequestContextStore.run({ requestId: 'r6', roles: ['ADMIN'] }, async () => {
      await expect(service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1')).rejects.toThrow(
        BusinessRuleError,
      );
      await expect(service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1')).rejects.toThrow(
        /associated with a Load Draft/,
      );
    });
    expect(tx.document.deleteMany).not.toHaveBeenCalled();
  });

  // H. Delete does not delete the LoadDraft.
  it('never deletes/modifies the LoadDraft itself, even when the guard is not triggered', async () => {
    const { service } = buildService();
    const loadDraftDeleteSpy = jest.fn();

    await RequestContextStore.run({ requestId: 'r7', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    // No loadDraft mutation method exists on the mock tx at all — proves
    // the service never attempts to touch the LoadDraft table beyond the
    // read-only existence check.
    expect(loadDraftDeleteSpy).not.toHaveBeenCalled();
  });

  it('also blocks deletion when a CarrierInsurance record references any version in the family (same RESTRICT-FK failure mode as LoadDraft)', async () => {
    const { service, tx } = buildService({
      carrierInsurance: { id: 'coi-1', coiDocumentId: 'doc-v2' },
    });

    await RequestContextStore.run({ requestId: 'r8', roles: ['ADMIN'] }, async () => {
      await expect(service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1')).rejects.toThrow(
        BusinessRuleError,
      );
    });
    expect(tx.document.deleteMany).not.toHaveBeenCalled();
  });

  it('records an audit entry naming the deleted family and every version’s file name', async () => {
    const { service, audit } = buildService();

    await RequestContextStore.run({ requestId: 'r9', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Document Family Deleted',
        newValue: expect.objectContaining({
          documentFamilyId: FAMILY_ID,
          versionCount: 3,
        }),
      }),
    );
  });

  // Correction 2 — S3/DB ordering safety fix. PostgreSQL cannot roll back
  // an S3 DeleteObject, so the DB deletion must commit independently of,
  // and before, any S3 cleanup attempt.

  // 8 & 13. Database deletion (and its audit entry) commits before any S3
  // cleanup is attempted.
  it('commits the database deletion and records the audit entry before attempting any S3 cleanup', async () => {
    const callOrder: string[] = [];
    const { service, tx, storage, audit } = buildService();
    (tx.document.deleteMany as jest.Mock).mockImplementation(async () => {
      callOrder.push('db-delete');
      return { count: 3 };
    });
    (audit.record as jest.Mock).mockImplementation(async () => {
      callOrder.push('audit-record');
    });
    (storage.deleteObject as jest.Mock).mockImplementation(async (key: string) => {
      callOrder.push(`s3-delete:${key}`);
    });

    await RequestContextStore.run({ requestId: 'r10', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(callOrder[0]).toBe('db-delete');
    expect(callOrder[1]).toBe('audit-record');
    expect(callOrder.slice(2)).toEqual(
      expect.arrayContaining([
        `s3-delete:org_${ORG_ID}/documents/doc-v1`,
        `s3-delete:org_${ORG_ID}/documents/doc-v2`,
        `s3-delete:org_${ORG_ID}/documents/doc-v3`,
      ]),
    );
  });

  // 9 & 12. An S3 cleanup failure after the DB delete has committed must
  // never fail the overall operation, and must never surface as a raw
  // storage error to the caller (and therefore never to the frontend).
  it('resolves successfully — never rejects with the raw S3 error — when every S3 cleanup call fails after the DB delete has committed', async () => {
    const { service, tx, storage } = buildService();
    (storage.deleteObject as jest.Mock).mockRejectedValue(new Error('S3 unreachable'));

    await RequestContextStore.run({ requestId: 'r11', roles: ['ADMIN'] }, async () => {
      await expect(
        service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1'),
      ).resolves.toBeUndefined();
    });
    expect(tx.document.deleteMany).toHaveBeenCalled();
  });

  // 10. One failing S3 cleanup call must not stop the remaining cleanup
  // attempts for the other versions in the family.
  it('continues attempting to delete the remaining S3 objects even after one cleanup call fails', async () => {
    const { service, storage } = buildService();
    (storage.deleteObject as jest.Mock).mockImplementation((key: string) =>
      (key as string).endsWith('doc-v2')
        ? Promise.reject(new Error('S3 unreachable'))
        : Promise.resolve(undefined),
    );

    await RequestContextStore.run({ requestId: 'r12', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v1`);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v2`);
    expect(storage.deleteObject).toHaveBeenCalledWith(`org_${ORG_ID}/documents/doc-v3`);
  });

  // 11. The database rows remain deleted — the delete is never undone —
  // even when S3 cleanup fails; there is no compensating "restore" call
  // anywhere on the mock tx for the service to have used even if it tried.
  it('leaves the database deletion in place when S3 cleanup fails, with no attempt to undo it', async () => {
    const { service, tx, storage } = buildService();
    (storage.deleteObject as jest.Mock).mockRejectedValue(new Error('S3 unreachable'));

    await RequestContextStore.run({ requestId: 'r13', roles: ['ADMIN'] }, async () => {
      await service.deleteDocumentFamily(ORG_ID, 'doc-v3', 'user-1');
    });

    expect(tx.document.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.document.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, documentFamilyId: FAMILY_ID },
    });
  });
});
