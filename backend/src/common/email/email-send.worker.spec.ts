import { Logger } from '@nestjs/common';
import { EmailSendWorker } from './email-send.worker';

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

describe('EmailSendWorker', () => {
  const JOB_DATA = {
    to: 'user@test.test',
    subject: 'Test Subject',
    body: 'Test body',
    organizationId: 'org-1',
    entityType: 'OrganizationMembership',
    entityId: 'membership-1',
  };

  function buildWorker(
    sendImpl: jest.Mock,
    options: { document?: Record<string, unknown> | null; getObjectImpl?: jest.Mock } = {},
  ) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const emailSender = { send: sendImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      document: {
        findFirst: jest
          .fn()
          .mockResolvedValue(options.document === undefined ? null : options.document),
      },
    };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const storage = {
      getObject: options.getObjectImpl ?? jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
    };

    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };
    const worker = new EmailSendWorker(
      redis as never,
      emailSender as never,
      prisma as never,
      audit as never,
      storage as never,
      heartbeat as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, emailSender, audit, prisma, storage, tx, heartbeat, worker };
  }

  it('sends via the injected IEmailSender and writes no audit entry on success', async () => {
    const sendImpl = jest.fn().mockResolvedValue(undefined);
    const { processor, emailSender, audit } = buildWorker(sendImpl);

    await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

    expect(emailSender.send).toHaveBeenCalledWith({
      to: JOB_DATA.to,
      subject: JOB_DATA.subject,
      body: JOB_DATA.body,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows on attempt 1 and attempt 2 of 3, so BullMQ retries — no audit entry written yet', async () => {
    const sendImpl = jest.fn().mockRejectedValue(new Error('provider timeout'));
    const { processor, audit } = buildWorker(sendImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } }),
    ).rejects.toThrow('provider timeout');
    await expect(
      processor({ data: JOB_DATA, attemptsMade: 1, opts: { attempts: 3 } }),
    ).rejects.toThrow('provider timeout');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('resolves (does not rethrow) and writes a SYSTEM-actor audit entry only after the 3rd (final) attempt fails', async () => {
    const sendImpl = jest.fn().mockRejectedValue(new Error('provider unavailable'));
    const { processor, audit, prisma } = buildWorker(sendImpl);

    await expect(
      processor({ data: JOB_DATA, attemptsMade: 2, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();

    expect(prisma.withTenantTransaction).toHaveBeenCalledWith(
      JOB_DATA.organizationId,
      expect.any(Function),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: JOB_DATA.organizationId,
        action: 'Email Delivery Failed',
        entityType: JOB_DATA.entityType,
        entityId: JOB_DATA.entityId,
        actorType: 'SYSTEM',
        actorUserId: null,
        newValue: expect.objectContaining({
          to: JOB_DATA.to,
          subject: JOB_DATA.subject,
          error: 'provider unavailable',
        }),
      }),
    );
  });

  // Monitoring Phase 4A-1 — the operational (application) log for a final
  // email-send failure must never contain the recipient address or
  // subject line (PII in a shared, unredacted log) — that detail belongs
  // only in the Audit DB record (recordFailure, asserted above), which
  // this change does not touch.
  it('logs the final failure without the recipient address or subject, while still including job ID and organizationId', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sendImpl = jest.fn().mockRejectedValue(new Error('provider unavailable'));
    const { processor, audit } = buildWorker(sendImpl);

    await processor({
      id: 'job-123',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
    });

    // Find the operational log call (not the generic worker.on('failed') hook, which isn't exercised here).
    const operationalLogCall = errorSpy.mock.calls.find((call) =>
      String(call[0]).startsWith('Email job'),
    );
    expect(operationalLogCall).toBeDefined();
    const [message] = operationalLogCall!;

    expect(message).toContain('job-123');
    expect(message).toContain(JOB_DATA.organizationId);
    expect(message).not.toContain(JOB_DATA.to);
    expect(message).not.toContain(JOB_DATA.subject);

    // The Audit DB record must still receive the full recipient/subject — unchanged.
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newValue: expect.objectContaining({
          to: JOB_DATA.to,
          subject: JOB_DATA.subject,
        }),
      }),
    );

    errorSpy.mockRestore();
  });

  // Monitoring Phase 4A-1 Item 3 — organizationId correlation on the
  // generic worker.on('failed') hook (the final-failure log above already
  // includes organizationId, from Item 2 — this covers the other log).
  it("includes organizationId in the generic worker.on('failed') log", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const sendImpl = jest.fn().mockResolvedValue(undefined);
    buildWorker(sendImpl);

    expect(capturedOn).toBeDefined();
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];
    expect(failedHandler).toBeDefined();

    failedHandler({ id: 'job-1', data: JOB_DATA }, new Error('boom'));

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Email send job'));
    expect(call).toBeDefined();
    expect(call![0]).toContain(JOB_DATA.organizationId);
    errorSpy.mockRestore();
  });

  describe('attachment resolution', () => {
    const DOCUMENT = {
      id: 'doc-1',
      organizationId: 'org-1',
      fileName: 'Rate Confirmation - LOAD-17278.pdf',
      fileStorageKey: 'org_org-1/documents/doc-1.pdf',
      mimeType: 'application/pdf',
    };

    it('existing attachment-less jobs still send with no attachments field, unchanged', async () => {
      const sendImpl = jest.fn().mockResolvedValue(undefined);
      const { processor, emailSender } = buildWorker(sendImpl);

      await processor({ data: JOB_DATA, attemptsMade: 0, opts: { attempts: 3 } });

      const callArgs = emailSender.send.mock.calls[0][0];
      expect(callArgs).not.toHaveProperty('attachments');
    });

    it('resolves the document and passes it as an attachment when attachmentDocumentId is set', async () => {
      const sendImpl = jest.fn().mockResolvedValue(undefined);
      const getObjectImpl = jest.fn().mockResolvedValue(Buffer.from('pdf-bytes'));
      const { processor, emailSender, tx } = buildWorker(sendImpl, {
        document: DOCUMENT,
        getObjectImpl,
      });

      const data = { ...JOB_DATA, attachmentDocumentId: 'doc-1' };
      await processor({ data, attemptsMade: 0, opts: { attempts: 3 } });

      expect(tx.document.findFirst).toHaveBeenCalledWith({
        where: { id: 'doc-1', organizationId: 'org-1' },
      });
      expect(getObjectImpl).toHaveBeenCalledWith(DOCUMENT.fileStorageKey);
      expect(emailSender.send).toHaveBeenCalledWith({
        to: data.to,
        subject: data.subject,
        body: data.body,
        attachments: [
          {
            filename: DOCUMENT.fileName,
            content: Buffer.from('pdf-bytes'),
            contentType: DOCUMENT.mimeType,
          },
        ],
      });
    });

    it('throws (and does not send) when the referenced document is not found', async () => {
      const sendImpl = jest.fn().mockResolvedValue(undefined);
      const { processor, emailSender } = buildWorker(sendImpl, { document: null });

      const data = { ...JOB_DATA, attachmentDocumentId: 'missing-doc' };
      await expect(processor({ data, attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(
        /missing-doc/,
      );
      expect(emailSender.send).not.toHaveBeenCalled();
    });

    it('throws (and does not send) when the storage object cannot be retrieved', async () => {
      const sendImpl = jest.fn().mockResolvedValue(undefined);
      const getObjectImpl = jest.fn().mockRejectedValue(new Error('storage unavailable'));
      const { processor, emailSender } = buildWorker(sendImpl, {
        document: DOCUMENT,
        getObjectImpl,
      });

      const data = { ...JOB_DATA, attachmentDocumentId: 'doc-1' };
      await expect(processor({ data, attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(
        'storage unavailable',
      );
      expect(emailSender.send).not.toHaveBeenCalled();
    });
  });

  describe('Monitoring Phase 4A-3 (worker heartbeat wiring)', () => {
    it('registers itself with WorkerHeartbeatService on init', () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(undefined));

      expect(heartbeat.register).toHaveBeenCalledWith('email-send-worker', expect.any(Function));
    });

    it("an 'active' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(undefined));
      const activeHandler = capturedOn!.mock.calls.find((c) => c[0] === 'active')?.[1];
      expect(activeHandler).toBeDefined();

      activeHandler();

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('email-send-worker', 'active');
    });

    it("a 'completed' event reports activity", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(undefined));
      const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];
      expect(completedHandler).toBeDefined();

      completedHandler({ id: 'job-1', data: JOB_DATA, processedOn: Date.now() - 50 });

      expect(heartbeat.recordActivity).toHaveBeenCalledWith('email-send-worker', 'completed');
    });

    it("a Worker-level 'error' event reports recordError", () => {
      const { heartbeat } = buildWorker(jest.fn().mockResolvedValue(undefined));
      const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();

      errorHandler(new Error('connection lost'));

      expect(heartbeat.recordError).toHaveBeenCalledWith('email-send-worker', 'error');
    });

    it('unregisters from WorkerHeartbeatService on shutdown', async () => {
      const { worker, heartbeat } = buildWorker(jest.fn().mockResolvedValue(undefined));

      await worker.onModuleDestroy();

      expect(heartbeat.unregister).toHaveBeenCalledWith('email-send-worker');
    });
  });
});

describe('EmailSendWorker — Monitoring Phase 4A-4 (job duration logging)', () => {
  const JOB_DATA = {
    to: 'user@test.test',
    subject: 'Test Subject',
    body: 'Test body',
    organizationId: 'org-1',
    entityType: 'OrganizationMembership',
    entityId: 'membership-1',
  };

  function buildWorker(sendImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const emailSender = { send: sendImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn({})),
    };
    const storage = { getObject: jest.fn() };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new EmailSendWorker(
      redis as never,
      emailSender as never,
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

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Email job'));
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

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Email job'));
    expect(call![0]).toBe(`Email job job-1 (org ${JOB_DATA.organizationId}) completed.`);
    logSpy.mockRestore();
  });

  it('includes duration in the final-attempt failure log, still without recipient/subject', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { processor } = buildWorker(jest.fn().mockRejectedValue(new Error('provider unavailable')));

    await processor({
      id: 'job-1',
      data: JOB_DATA,
      attemptsMade: 2,
      opts: { attempts: 3 },
      processedOn: Date.now() - 400,
    });

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Email job'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/failed after 3 attempts \(\d+ms\)\./);
    expect(call![0]).not.toContain(JOB_DATA.to);
    expect(call![0]).not.toContain(JOB_DATA.subject);
    errorSpy.mockRestore();
  });
});

describe('EmailSendWorker — Monitoring Phase 4A-5 (stalled-event observability)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const emailSender = { send: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = { withTenantTransaction: jest.fn() };
    const storage = { getObject: jest.fn() };
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    new EmailSendWorker(
      redis as never,
      emailSender as never,
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

    expect(warnSpy).toHaveBeenCalledWith('Email job job-42 stalled (was active).');
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
    expect(message).toBe('Email job job-42 stalled (was active).');
    expect(message).not.toMatch(/org[a-zA-Z]*=/i);
    warnSpy.mockRestore();
  });
});
