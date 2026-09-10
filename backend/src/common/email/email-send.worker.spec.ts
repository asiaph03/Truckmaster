import { Logger } from '@nestjs/common';
import { EmailSendWorker } from './email-send.worker';

type Processor = (job: {
  id?: string;
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

    const worker = new EmailSendWorker(
      redis as never,
      emailSender as never,
      prisma as never,
      audit as never,
      storage as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, emailSender, audit, prisma, storage, tx };
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
});
