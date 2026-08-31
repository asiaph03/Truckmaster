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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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
    const audit = {};

    return new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
    );
  }

  it('issues a signed URL when scan_status is CLEAN', async () => {
    const service = buildService('CLEAN');
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

    return new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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

  function buildService(opts: { load?: Record<string, unknown> | null } = {}) {
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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
    );

    return { service, tx };
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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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

  it('rejects uploading a non-POD document type against a Stop', async () => {
    const { service } = buildService({ documentType: { id: 'bol-1', code: 'BOL' } });
    await RequestContextStore.run({ requestId: 'r3', roles: ['ADMIN'] }, async () => {
      await expect(
        service.initiateUpload(ORG_ID, { ...POD_UPLOAD_DTO, documentTypeId: 'bol-1' }, 'user-1'),
      ).rejects.toThrow(/Only POD documents can be uploaded against a Stop/);
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

    const service = new DocumentService(
      prisma as never,
      audit as never,
      storage as never,
      carrierEligibility as never,
      loadPodStatus as never,
      scanQueue as never,
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
