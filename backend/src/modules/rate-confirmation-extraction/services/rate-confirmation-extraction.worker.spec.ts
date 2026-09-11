import { Logger } from '@nestjs/common';
import { RateConfirmationExtractionWorker } from './rate-confirmation-extraction.worker';

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

/**
 * Monitoring Phase 4A-1 Item 3 — this worker previously had no dedicated
 * unit test coverage at all. This file covers both the pre-existing
 * behavior (success, retry, final-failure) and the new organizationId
 * log-correlation change, following the same conventions as the other
 * worker specs in this codebase (MalwareScanWorker in particular, which
 * this worker's structure mirrors).
 */
describe('RateConfirmationExtractionWorker', () => {
  const JOB_DATA = {
    extractionId: 'extraction-1',
    documentId: 'doc-1',
    organizationId: 'org-1',
    storageKey: 'org_org-1/documents/doc-1',
  };
  const PDF_BYTES = Buffer.from('pdf-bytes');

  function buildWorker(extractImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const extractor = { extract: extractImpl };
    const storage = { getObject: jest.fn().mockResolvedValue(PDF_BYTES) };
    const jobStore = {
      markInProgress: jest.fn().mockResolvedValue(undefined),
      markComplete: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };
    const worker = new RateConfirmationExtractionWorker(
      redis as never,
      extractor as never,
      storage as never,
      jobStore as never,
      heartbeat as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, extractor, storage, jobStore, heartbeat, worker };
  }

  it('marks in-progress, extracts, and marks complete on a successful first attempt', async () => {
    const extractImpl = jest
      .fn()
      .mockResolvedValue({ multiLoadDetected: false, data: { loadNumber: 'L-1001' } });
    const { processor, storage, jobStore } = buildWorker(extractImpl);

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(jobStore.markInProgress).toHaveBeenCalledWith(JOB_DATA.organizationId, JOB_DATA.extractionId);
    expect(storage.getObject).toHaveBeenCalledWith(JOB_DATA.storageKey, {
      organizationId: JOB_DATA.organizationId,
      jobId: undefined,
    });
    expect(extractImpl).toHaveBeenCalledWith(PDF_BYTES, JOB_DATA.extractionId, {
      organizationId: JOB_DATA.organizationId,
      jobId: undefined,
    });
    expect(jobStore.markComplete).toHaveBeenCalledWith(
      JOB_DATA.organizationId,
      JOB_DATA.extractionId,
      { loadNumber: 'L-1001' },
    );
    expect(jobStore.markFailed).not.toHaveBeenCalled();
  });

  it('threads the job id through to StorageService.getObject() as jobId, alongside organizationId (Monitoring Phase 4A-13)', async () => {
    const extractImpl = jest
      .fn()
      .mockResolvedValue({ multiLoadDetected: false, data: { loadNumber: 'L-1001' } });
    const { processor, storage } = buildWorker(extractImpl);

    await processor({ id: 'job-99', data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(storage.getObject).toHaveBeenCalledWith(JOB_DATA.storageKey, {
      organizationId: JOB_DATA.organizationId,
      jobId: 'job-99',
    });
  });

  it('threads organizationId and jobId into extractor.extract() as context (Monitoring Phase 4A-14)', async () => {
    const extractImpl = jest
      .fn()
      .mockResolvedValue({ multiLoadDetected: false, data: { loadNumber: 'L-1001' } });
    const { processor, extractor } = buildWorker(extractImpl);

    await processor({ id: 'job-99', data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(extractor.extract).toHaveBeenCalledWith(PDF_BYTES, JOB_DATA.extractionId, {
      organizationId: JOB_DATA.organizationId,
      jobId: 'job-99',
    });
  });

  it('marks failed with a multi-load message when multiLoadDetected is true, without marking complete', async () => {
    const extractImpl = jest.fn().mockResolvedValue({ multiLoadDetected: true, data: {} });
    const { processor, jobStore } = buildWorker(extractImpl);

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(jobStore.markFailed).toHaveBeenCalledWith(
      JOB_DATA.organizationId,
      JOB_DATA.extractionId,
      expect.stringContaining('multiple loads'),
    );
    expect(jobStore.markComplete).not.toHaveBeenCalled();
  });

  it('rethrows on attempt 1 of 3 (a thrown extractor error) and does not mark failed yet', async () => {
    const extractImpl = jest.fn().mockRejectedValue(new Error('extraction service unavailable'));
    const { processor, jobStore } = buildWorker(extractImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } }),
    ).rejects.toThrow('extraction service unavailable');

    expect(jobStore.markFailed).not.toHaveBeenCalled();
  });

  it('resolves (does not rethrow) and marks failed only after the 3rd (final) attempt', async () => {
    const extractImpl = jest.fn().mockRejectedValue(new Error('extraction service unavailable'));
    const { processor, jobStore } = buildWorker(extractImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();

    expect(jobStore.markFailed).toHaveBeenCalledWith(
      JOB_DATA.organizationId,
      JOB_DATA.extractionId,
      'extraction service unavailable',
    );
  });

  // Monitoring Phase 4A-1 Item 3 — organizationId correlation in operational logs.
  it('includes organizationId in the success log', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const extractImpl = jest
      .fn()
      .mockResolvedValue({ multiLoadDetected: false, data: { loadNumber: 'L-1001' } });
    const { processor } = buildWorker(extractImpl);

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(JOB_DATA.organizationId));
    logSpy.mockRestore();
  });

  it('includes organizationId in the final-failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const extractImpl = jest.fn().mockRejectedValue(new Error('extraction service unavailable'));
    const { processor } = buildWorker(extractImpl);

    await processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } });

    const call = errorSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('Rate Confirmation extraction'),
    );
    expect(call).toBeDefined();
    expect(call![0]).toContain(JOB_DATA.organizationId);
    errorSpy.mockRestore();
  });

  it("includes organizationId in the generic worker.on('failed') log", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const extractImpl = jest
      .fn()
      .mockResolvedValue({ multiLoadDetected: false, data: { loadNumber: 'L-1001' } });
    buildWorker(extractImpl);

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
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue({ multiLoadDetected: false, data: {} }));

      expect(heartbeat.register).toHaveBeenCalledWith(
        'rate-confirmation-extraction-worker',
        expect.any(Function),
      );
    });

    it("an 'active' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue({ multiLoadDetected: false, data: {} }));
      const activeHandler = capturedOn!.mock.calls.find((c) => c[0] === 'active')?.[1];
      expect(activeHandler).toBeDefined();

      activeHandler();

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('rate-confirmation-extraction-worker', 'active');
    });

    it("a 'completed' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue({ multiLoadDetected: false, data: {} }));
      const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];
      expect(completedHandler).toBeDefined();

      completedHandler({
        id: 'job-1',
        data: { extractionId: 'extraction-1', organizationId: 'org-1' },
        processedOn: Date.now() - 50,
      });

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('rate-confirmation-extraction-worker', 'completed');
    });

    it("a Worker-level 'error' event reports recordError", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue({ multiLoadDetected: false, data: {} }));
      const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      errorHandler(new Error('connection lost'));

      expect(heartbeat.recordError).toHaveBeenCalledWith('rate-confirmation-extraction-worker', 'error');
    });

    it('unregisters from WorkerHeartbeatService on shutdown', async () => {
      const { worker, heartbeat } = buildWorker(jest.fn().mockResolvedValue({ multiLoadDetected: false, data: {} }));

      await worker.onModuleDestroy();

      expect(heartbeat.unregister).toHaveBeenCalledWith('rate-confirmation-extraction-worker');
    });
  });
});

describe('RateConfirmationExtractionWorker — Monitoring Phase 4A-4 (job duration logging)', () => {
  const JOB_DATA = {
    extractionId: 'extraction-1',
    documentId: 'doc-1',
    organizationId: 'org-1',
    storageKey: 'org_org-1/documents/doc-1',
  };

  function buildWorker(extractImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const extractor = { extract: extractImpl };
    const storage = { getObject: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) };
    const jobStore = {
      markInProgress: jest.fn().mockResolvedValue(undefined),
      markComplete: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new RateConfirmationExtractionWorker(
      redis as never,
      extractor as never,
      storage as never,
      jobStore as never,
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

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Rate Confirmation extraction job'));
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

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Rate Confirmation extraction job'));
    expect(call![0]).toBe(`Rate Confirmation extraction job job-1 (org ${JOB_DATA.organizationId}) completed.`);
    logSpy.mockRestore();
  });

  it('includes duration in the final-attempt failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = buildWorker(jest.fn().mockRejectedValue(new Error('extraction service unavailable')));

    await processor({
      id: 'job-1',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
      processedOn: Date.now() - 400,
    });

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Rate Confirmation extraction extraction-1'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/failed after 3 attempts \(\d+ms\)\./);
    errorSpy.mockRestore();
  });
});

describe('RateConfirmationExtractionWorker — Monitoring Phase 4A-5 (stalled-event observability)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const extractor = { extract: jest.fn() };
    const storage = { getObject: jest.fn() };
    const jobStore = {
      markInProgress: jest.fn(),
      markComplete: jest.fn(),
      markFailed: jest.fn(),
    };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new RateConfirmationExtractionWorker(
      redis as never,
      extractor as never,
      storage as never,
      jobStore as never,
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

    expect(warnSpy).toHaveBeenCalledWith('Rate Confirmation extraction job job-42 stalled (was active).');
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
    expect(message).toBe('Rate Confirmation extraction job job-42 stalled (was active).');
    expect(message).not.toMatch(/org[a-zA-Z]*=/i);
    warnSpy.mockRestore();
  });
});

describe('RateConfirmationExtractionWorker — Monitoring Phase 4A-14 (Anthropic extraction logging security)', () => {
  const JOB_DATA = {
    extractionId: 'extraction-1',
    documentId: 'doc-1',
    organizationId: 'org-1',
    storageKey: 'org_org-1/documents/doc-1',
  };
  const SENSITIVE_MARKER = 'SENSITIVE_ANTHROPIC_ERROR_CONTENT';

  function buildWorker(extractImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const extractor = { extract: extractImpl };
    const storage = { getObject: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) };
    const jobStore = {
      markInProgress: jest.fn().mockResolvedValue(undefined),
      markComplete: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new RateConfirmationExtractionWorker(
      redis as never,
      extractor as never,
      storage as never,
      jobStore as never,
      heartbeat as never,
    ).onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    return { processor: capturedProcessor as Processor };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the final-attempt failure log call has no second (trace) argument at all', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const originalError = Object.assign(new Error('502 overloaded_error'), {
      status: 529,
      stack: 'Error: 502 overloaded_error\n    at fake-stack',
    });
    const { processor } = buildWorker(jest.fn().mockRejectedValue(originalError));

    await processor({
      id: 'job-1',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
      processedOn: Date.now() - 100,
    });

    const call = errorSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('Rate Confirmation extraction extraction-1'),
    );
    expect(call).toBeDefined();
    expect(call).toHaveLength(1);
  });

  it('SECURITY — an Anthropic APIError carrying a sensitive marker in message/stack/error never appears in any worker logger call', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const sensitiveError = Object.assign(new Error(`400 ${SENSITIVE_MARKER}`), {
      status: 400,
      stack: `Error: 400 ${SENSITIVE_MARKER}\n    at fake-stack (${SENSITIVE_MARKER})`,
      error: { type: 'invalid_request_error', message: SENSITIVE_MARKER },
      headers: new Map([['request-id', SENSITIVE_MARKER]]),
      requestID: SENSITIVE_MARKER,
      workspaceID: SENSITIVE_MARKER,
    });
    const { processor } = buildWorker(jest.fn().mockRejectedValue(sensitiveError));

    await processor({
      id: 'job-1',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
      processedOn: Date.now() - 100,
    });

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(SENSITIVE_MARKER);
      }
    }
  });
});

describe('RateConfirmationExtractionWorker — Monitoring Phase 4A-15 (generic BullMQ failure/error logging security)', () => {
  const JOB_DATA = {
    extractionId: 'extraction-1',
    documentId: 'doc-1',
    organizationId: 'org-1',
    storageKey: 'org_org-1/documents/doc-1',
  };
  const SENSITIVE_MARKER = 'SENSITIVE_BULLMQ_ERROR_CONTENT';

  function buildWorker(extractImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const extractor = { extract: extractImpl };
    const storage = { getObject: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')) };
    const jobStore = {
      markInProgress: jest.fn().mockResolvedValue(undefined),
      markComplete: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };
    new RateConfirmationExtractionWorker(
      redis as never,
      extractor as never,
      storage as never,
      jobStore as never,
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
      'event=job_failed worker=rate-confirmation-extraction-worker queue=rate-confirmation-extraction jobId=job-1 organizationId=org-1 attempt=2 maxAttempts=3 errorType=Error',
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
      'event=worker_error worker=rate-confirmation-extraction-worker queue=rate-confirmation-extraction errorType=Error',
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
