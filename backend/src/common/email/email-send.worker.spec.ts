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

  function buildWorker(sendImpl: jest.Mock) {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ quit: jest.fn() }) };
    const emailSender = { send: sendImpl };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const tx = {};
    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const worker = new EmailSendWorker(
      redis as never,
      emailSender as never,
      prisma as never,
      audit as never,
    );
    worker.onModuleInit();
    if (!capturedProcessor) throw new Error('Worker processor was not captured');
    const processor: Processor = capturedProcessor;
    return { processor, emailSender, audit, prisma };
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
});
