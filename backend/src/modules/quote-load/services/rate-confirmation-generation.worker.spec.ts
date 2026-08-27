import { RateConfirmationGenerationWorker } from './rate-confirmation-generation.worker';

type Processor = (job: {
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

let capturedProcessor: Processor | undefined;

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    capturedProcessor = processor;
    return { on: jest.fn(), close: jest.fn() };
  }),
}));

describe('RateConfirmationGenerationWorker', () => {
  const JOB_DATA = { documentId: 'doc-1', organizationId: 'org-1', loadId: 'load-1' };
  const DOCUMENT = { id: 'doc-1', fileStorageKey: 'org_org-1/documents/doc-1' };
  const LOAD = {
    id: 'load-1',
    loadNumber: 'L-1001',
    equipmentType: 'DRY_VAN',
    carrierRate: '1500.00',
    assignedCarrier: { legalName: 'Acme Carrier LLC' },
    customer: { legalName: 'Acme Shipper LLC' },
    stops: [{ sequence: 1, stopType: 'PICKUP', city: 'Dallas', state: 'TX' }],
  };

  function buildWorker(generateImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ quit: jest.fn() }) };
    const pdfGenerator = { generateRateConfirmation: generateImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(DOCUMENT),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      load: {
        findFirst: jest.fn().mockResolvedValue(LOAD),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const worker = new RateConfirmationGenerationWorker(
      redis as never,
      pdfGenerator as never,
      prisma as never,
      audit as never,
      storage as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, pdfGenerator, audit, storage, tx };
  }

  it('generates the PDF, uploads it, marks the document COMPLETE, and audits on a successful first attempt', async () => {
    const pdfBytes = Buffer.from('pdf-bytes');
    const generateImpl = jest.fn().mockResolvedValue(pdfBytes);
    const { processor, storage, tx, audit } = buildWorker(generateImpl);

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(storage.putObject).toHaveBeenCalledWith(
      DOCUMENT.fileStorageKey,
      pdfBytes,
      'application/pdf',
    );
    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT.id },
      data: { fileSizeBytes: BigInt(pdfBytes.length), generationStatus: 'COMPLETE' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: JOB_DATA.organizationId,
        action: 'Rate Confirmation PDF Generated',
        entityType: 'Load',
        entityId: JOB_DATA.loadId,
        actorType: 'SYSTEM',
      }),
    );
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('rethrows on attempt 1 of 3 (a thrown PDF-generator error) and does not mark the document FAILED yet', async () => {
    const generateImpl = jest.fn().mockRejectedValue(new Error('renderer crashed'));
    const { processor, tx, audit } = buildWorker(generateImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } }),
    ).rejects.toThrow('renderer crashed');

    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows on attempt 2 of 3 and still does not mark the document FAILED', async () => {
    const generateImpl = jest.fn().mockRejectedValue(new Error('renderer crashed'));
    const { processor, tx, audit } = buildWorker(generateImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 } }),
    ).rejects.toThrow('renderer crashed');

    expect(tx.document.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('resolves (does not rethrow) and marks the document generationStatus FAILED only after the 3rd (final) attempt — no audit record on this path', async () => {
    const generateImpl = jest.fn().mockRejectedValue(new Error('renderer crashed'));
    const { processor, tx, audit } = buildWorker(generateImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();

    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB_DATA.documentId, organizationId: JOB_DATA.organizationId },
      data: { generationStatus: 'FAILED' },
    });
    // The worker's markFailed() path never calls AuditService.record — only
    // the success path in processJob() does. Confirmed by reading
    // rate-confirmation-generation.worker.ts directly (no audit.record call
    // in markFailed).
    expect(audit.record).not.toHaveBeenCalled();
  });
});
