import { EmailSendWorker } from './email-send.worker';

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
    const redis = { duplicate: jest.fn().mockReturnValue({ quit: jest.fn() }) };
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
