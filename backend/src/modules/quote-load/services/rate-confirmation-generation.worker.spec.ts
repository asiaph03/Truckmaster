import { Logger } from '@nestjs/common';
import { RateConfirmationGenerationWorker } from './rate-confirmation-generation.worker';

type Processor = (job: {
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

let capturedProcessor: Processor | undefined;
let capturedOn: jest.Mock | undefined;

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    capturedProcessor = processor;
    capturedOn = jest.fn();
    return { on: capturedOn, close: jest.fn() };
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
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
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

    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };
    const worker = new RateConfirmationGenerationWorker(
      redis as never,
      pdfGenerator as never,
      prisma as never,
      audit as never,
      storage as never,
      heartbeat as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, pdfGenerator, audit, storage, tx, heartbeat, worker };
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

  // Monitoring Phase 4A-1 Item 3 — organizationId correlation in operational logs.
  it('includes organizationId in the final-failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const generateImpl = jest.fn().mockRejectedValue(new Error('renderer crashed'));
    const { processor } = buildWorker(generateImpl);

    await processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } });

    const call = errorSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('Rate Confirmation PDF generation'),
    );
    expect(call).toBeDefined();
    expect(call![0]).toContain(JOB_DATA.organizationId);
    errorSpy.mockRestore();
  });

  it("includes organizationId in the generic worker.on('failed') log", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const generateImpl = jest.fn().mockResolvedValue(Buffer.from('pdf-bytes'));
    buildWorker(generateImpl);

    expect(capturedOn).toBeDefined();
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];
    expect(failedHandler).toBeDefined();

    failedHandler({ id: 'job-1', data: JOB_DATA }, new Error('boom'));

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Rate Confirmation PDF job'));
    expect(call).toBeDefined();
    expect(call![0]).toContain(JOB_DATA.organizationId);
    errorSpy.mockRestore();
  });

  describe('Monitoring Phase 4A-3 (worker heartbeat wiring)', () => {
    it('registers itself with WorkerHeartbeatService on init', () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));

      expect(heartbeat.register).toHaveBeenCalledWith(
        'rate-confirmation-pdf-worker',
        expect.any(Function),
      );
    });

    it("an 'active' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const activeHandler = capturedOn!.mock.calls.find((c) => c[0] === 'active')?.[1];
      expect(activeHandler).toBeDefined();

      activeHandler();

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('rate-confirmation-pdf-worker', 'active');
    });

    it("a 'completed' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];
      expect(completedHandler).toBeDefined();

      completedHandler();

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('rate-confirmation-pdf-worker', 'completed');
    });

    it("a Worker-level 'error' event reports recordError", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      errorHandler(new Error('connection lost'));

      expect(heartbeat.recordError).toHaveBeenCalledWith('rate-confirmation-pdf-worker', 'error');
    });

    it('unregisters from WorkerHeartbeatService on shutdown', async () => {
      const { worker, heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));

      await worker.onModuleDestroy();

      expect(heartbeat.unregister).toHaveBeenCalledWith('rate-confirmation-pdf-worker');
    });
  });
});
