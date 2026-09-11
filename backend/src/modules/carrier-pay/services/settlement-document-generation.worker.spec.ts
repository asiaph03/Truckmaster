import { Logger } from '@nestjs/common';
import { SettlementDocumentGenerationWorker } from './settlement-document-generation.worker';

type Processor = (job: {
  id?: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
  processedOn?: number;
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

describe('SettlementDocumentGenerationWorker', () => {
  const JOB_DATA = { documentId: 'doc-1', organizationId: 'org-1', carrierPaymentId: 'cp-1' };
  const DOCUMENT = { id: 'doc-1', fileStorageKey: 'org_org-1/documents/doc-1' };
  const CARRIER_PAYMENT = {
    id: 'cp-1',
    paymentType: 'LINEHAUL',
    amount: '1200.00',
    method: 'ACH',
    referenceNumber: 'REF-1',
    paidAt: new Date('2026-08-20'),
    carrier: { legalName: 'Acme Carrier LLC' },
    load: { loadNumber: 'L-1001' },
  };

  function buildWorker(generateImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const pdfGenerator = { generateSettlement: generateImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(DOCUMENT),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      carrierPayment: {
        findFirst: jest.fn().mockResolvedValue(CARRIER_PAYMENT),
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
    const worker = new SettlementDocumentGenerationWorker(
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
      { organizationId: JOB_DATA.organizationId, jobId: undefined },
    );
    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT.id },
      data: { fileSizeBytes: BigInt(pdfBytes.length), generationStatus: 'COMPLETE' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: JOB_DATA.organizationId,
        action: 'Settlement PDF Generated',
        entityType: 'CarrierPayment',
        entityId: JOB_DATA.carrierPaymentId,
        actorType: 'SYSTEM',
      }),
    );
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('threads the job id through to StorageService.putObject() as jobId, alongside organizationId (Monitoring Phase 4A-13)', async () => {
    const pdfBytes = Buffer.from('pdf-bytes');
    const generateImpl = jest.fn().mockResolvedValue(pdfBytes);
    const { processor, storage } = buildWorker(generateImpl);

    await processor({ id: 'job-99', data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(storage.putObject).toHaveBeenCalledWith(
      DOCUMENT.fileStorageKey,
      pdfBytes,
      'application/pdf',
      { organizationId: JOB_DATA.organizationId, jobId: 'job-99' },
    );
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
    // markFailed() never calls AuditService.record — only the success path
    // in processJob() does. Confirmed by reading
    // settlement-document-generation.worker.ts directly.
    expect(audit.record).not.toHaveBeenCalled();
  });

  // Monitoring Phase 4A-1 Item 3 — organizationId correlation in operational logs.
  it('includes organizationId in the final-failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const generateImpl = jest.fn().mockRejectedValue(new Error('renderer crashed'));
    const { processor } = buildWorker(generateImpl);

    await processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } });

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Settlement PDF generation'));
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

    failedHandler(
      { id: 'job-1', data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('boom'),
    );

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('event=job_failed'));
    expect(call).toBeDefined();
    expect(call![0]).toContain(JOB_DATA.organizationId);
    errorSpy.mockRestore();
  });

  describe('Monitoring Phase 4A-3 (worker heartbeat wiring)', () => {
    it('registers itself with WorkerHeartbeatService on init', () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));

      expect(heartbeat.register).toHaveBeenCalledWith('settlement-pdf-worker', expect.any(Function));
    });

    it("an 'active' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const activeHandler = capturedOn!.mock.calls.find((c) => c[0] === 'active')?.[1];
      expect(activeHandler).toBeDefined();

      activeHandler();

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('settlement-pdf-worker', 'active');
    });

    it("a 'completed' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];
      expect(completedHandler).toBeDefined();

      completedHandler({ id: 'job-1', data: JOB_DATA, processedOn: Date.now() - 50 });

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('settlement-pdf-worker', 'completed');
    });

    it("a Worker-level 'error' event reports recordError", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));
      const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      errorHandler(new Error('connection lost'));

      expect(heartbeat.recordError).toHaveBeenCalledWith('settlement-pdf-worker', 'error');
    });

    it('unregisters from WorkerHeartbeatService on shutdown', async () => {
      const { worker, heartbeat } = buildWorker(jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')));

      await worker.onModuleDestroy();

      expect(heartbeat.unregister).toHaveBeenCalledWith('settlement-pdf-worker');
    });
  });
});

describe('SettlementDocumentGenerationWorker — Monitoring Phase 4A-4 (job duration logging)', () => {
  const JOB_DATA = { documentId: 'doc-1', organizationId: 'org-1', carrierPaymentId: 'cp-1' };
  const DOCUMENT = { id: 'doc-1', fileStorageKey: 'org_org-1/documents/doc-1' };
  const CARRIER_PAYMENT = {
    id: 'cp-1',
    paymentType: 'LINEHAUL',
    amount: '1200.00',
    method: 'ACH',
    referenceNumber: 'REF-1',
    paidAt: new Date('2026-08-20'),
    carrier: { legalName: 'Acme Carrier LLC' },
    load: { loadNumber: 'L-1001' },
  };

  function buildWorker(generateImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const pdfGenerator = { generateSettlement: generateImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(DOCUMENT),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      carrierPayment: { findFirst: jest.fn().mockResolvedValue(CARRIER_PAYMENT) },
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

    new SettlementDocumentGenerationWorker(
      redis as never,
      pdfGenerator as never,
      prisma as never,
      audit as never,
      storage as never,
      heartbeat as never,
    ).onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor };
  }

  it("a 'completed' event logs a duration derived from job.processedOn", () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];

    completedHandler({ id: 'job-1', data: JOB_DATA, processedOn: Date.now() - 250 });

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Settlement PDF job'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/completed in \d+ms\./);
    logSpy.mockRestore();
  });

  it('does not crash and omits the duration when job.processedOn is missing (unexpected event sequence)', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];

    expect(() =>
      completedHandler({ id: 'job-1', data: JOB_DATA, processedOn: undefined }),
    ).not.toThrow();

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Settlement PDF job'));
    expect(call![0]).toBe(`Settlement PDF job job-1 (org ${JOB_DATA.organizationId}) completed.`);
    logSpy.mockRestore();
  });

  it('includes duration in the final-attempt failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = buildWorker(jest.fn().mockRejectedValue(new Error('renderer crashed')));

    await processor({
      id: 'job-1',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
      processedOn: Date.now() - 400,
    });

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Settlement PDF generation'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/failed after 3 attempts \(\d+ms\) — recording FAILED\./);
    errorSpy.mockRestore();
  });
});

describe('SettlementDocumentGenerationWorker — Monitoring Phase 4A-5 (stalled-event observability)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const pdfGenerator = { generateSettlement: jest.fn() };
    const audit = { record: jest.fn() };
    const storage = { putObject: jest.fn() };
    const prisma = { withTenantTransaction: jest.fn() };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new SettlementDocumentGenerationWorker(
      redis as never,
      pdfGenerator as never,
      prisma as never,
      audit as never,
      storage as never,
      heartbeat as never,
    ).onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    return { heartbeat };
  }

  it("a 'stalled' event logs a warning with the worker label, jobId, and prev state", () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    buildWorker();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];
    expect(stalledHandler).toBeDefined();

    stalledHandler('job-42', 'active');

    expect(warnSpy).toHaveBeenCalledWith('Settlement PDF job job-42 stalled (was active).');
    warnSpy.mockRestore();
  });

  it('does not touch WorkerHeartbeatService in any way', () => {
    const { heartbeat } = buildWorker();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];

    stalledHandler('job-42', 'active');

    expect(heartbeat.recordActivity).not.toHaveBeenCalled();
    expect(heartbeat.recordError).not.toHaveBeenCalled();
    expect(heartbeat.register).toHaveBeenCalledTimes(1);
    expect(heartbeat.unregister).not.toHaveBeenCalled();
  });

  it('security/PII — the stalled log contains only jobId and prev, never organizationId or job data', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    buildWorker();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];

    stalledHandler('job-42', 'active');

    const [message] = warnSpy.mock.calls[0];
    expect(message).toBe('Settlement PDF job job-42 stalled (was active).');
    expect(message).not.toMatch(/org[a-zA-Z]*=/i);
    warnSpy.mockRestore();
  });
});

describe('SettlementDocumentGenerationWorker — Monitoring Phase 4A-15 (generic BullMQ failure/error logging security)', () => {
  const JOB_DATA = { documentId: 'doc-1', organizationId: 'org-1', carrierPaymentId: 'cp-1' };
  const DOCUMENT = { id: 'doc-1', fileStorageKey: 'org_org-1/documents/doc-1' };
  const CARRIER_PAYMENT = {
    id: 'cp-1',
    paymentType: 'LINEHAUL',
    amount: '1200.00',
    method: 'ACH',
    referenceNumber: 'REF-1',
    paidAt: new Date('2026-08-20'),
    carrier: { legalName: 'Acme Carrier LLC' },
    load: { loadNumber: 'L-1001' },
  };
  const SENSITIVE_MARKER = 'SENSITIVE_BULLMQ_ERROR_CONTENT';

  function buildWorker(generateImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const pdfGenerator = { generateSettlement: generateImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(DOCUMENT),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      carrierPayment: { findFirst: jest.fn().mockResolvedValue(CARRIER_PAYMENT) },
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
    new SettlementDocumentGenerationWorker(
      redis as never,
      pdfGenerator as never,
      prisma as never,
      audit as never,
      storage as never,
      heartbeat as never,
    ).onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    return { processor: capturedProcessor as Processor };
  }

  function sensitiveError(): Error {
    return Object.assign(new Error(`${SENSITIVE_MARKER}`), {
      stack: `Error: ${SENSITIVE_MARKER}\n    at fake-stack (${SENSITIVE_MARKER})`,
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("the generic worker.on('failed') log contains only safe metadata: event, worker, queue, jobId, organizationId, attempt, maxAttempts, errorType", () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    failedHandler(
      { id: 'job-1', data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } },
      new Error('boom'),
    );

    expect(errorSpy).toHaveBeenCalledWith(
      'event=job_failed worker=settlement-pdf-worker queue=settlement-pdf jobId=job-1 organizationId=org-1 attempt=2 maxAttempts=3 errorType=Error',
    );
  });

  it("SECURITY — worker.on('failed') never logs a sensitive marker present in error.message/.stack", () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    failedHandler(
      { id: 'job-1', data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 } },
      sensitiveError(),
    );

    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it("worker.on('error') logs only worker/queue/errorType — no jobId/organizationId/attempt fabricated", () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];

    errorHandler(new Error('connection lost'));

    expect(errorSpy).toHaveBeenCalledWith(
      'event=worker_error worker=settlement-pdf-worker queue=settlement-pdf errorType=Error',
    );
  });

  it("SECURITY — worker.on('error') never logs a sensitive marker present in error.message/.stack", () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];

    errorHandler(sensitiveError());

    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it('SECURITY — the processor final-attempt catch never logs a sensitive marker present in error.message/.stack', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = buildWorker(jest.fn().mockRejectedValue(sensitiveError()));

    await processor({ id: 'job-1', data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } });

    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });

  it("the 'failed' event still calls Logger.error with exactly one argument (no trace/second argument)", () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    buildWorker(jest.fn());
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    failedHandler(
      { id: 'job-1', data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('boom'),
    );

    expect(errorSpy.mock.calls[0]).toHaveLength(1);
  });
});
