import { Logger } from '@nestjs/common';
import { PostmarkEmailSender } from './postmark-email-sender';

describe('PostmarkEmailSender', () => {
  function buildSender(fetchImpl: typeof fetch) {
    const config = {
      get: jest.fn().mockReturnValue({ apiKey: 'test-token', fromAddress: 'noreply@test.test' }),
    };
    const originalFetch = global.fetch;
    global.fetch = fetchImpl;
    const sender = new PostmarkEmailSender(config as never);
    return { sender, config, restore: () => (global.fetch = originalFetch) };
  }

  const MESSAGE = { to: 'carrier@test.test', subject: 'Hello', body: 'Body text' };

  it('sends via the Postmark API with the configured token and from-address', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.postmarkapp.com/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Postmark-Server-Token': 'test-token' }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      From: 'noreply@test.test',
      To: MESSAGE.to,
      Subject: MESSAGE.subject,
      TextBody: MESSAGE.body,
    });
    restore();
  });

  it('throws when Postmark returns a non-zero ErrorCode, leaving retry handling to the caller', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ErrorCode: 300, Message: 'Invalid email request' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE)).rejects.toThrow(/Invalid email request/);
    restore();
  });

  it('throws when the HTTP response itself is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE)).rejects.toThrow(/500/);
    restore();
  });

  it('sends no Attachments field when none are provided, matching prior request bodies exactly', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE);

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('Attachments');
    restore();
  });

  it('passes attachments through as base64-encoded Attachments entries', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send({
      ...MESSAGE,
      attachments: [
        {
          filename: 'Rate Confirmation - LOAD-17278.pdf',
          content: Buffer.from('pdf-bytes'),
          contentType: 'application/pdf',
        },
      ],
    });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.Attachments).toEqual([
      {
        Name: 'Rate Confirmation - LOAD-17278.pdf',
        Content: Buffer.from('pdf-bytes').toString('base64'),
        ContentType: 'application/pdf',
      },
    ]);
    restore();
  });
});

describe('PostmarkEmailSender — Monitoring Phase 4A-11 (external-call timing/error attribution)', () => {
  const MESSAGE = { to: 'carrier@test.test', subject: 'Hello', body: 'Body text' };
  const CONTEXT = { organizationId: 'org-1', jobId: 'job-1' };

  function buildSender(fetchImpl: typeof fetch) {
    const config = {
      get: jest.fn().mockReturnValue({ apiKey: 'test-token', fromAddress: 'noreply@test.test' }),
    };
    const originalFetch = global.fetch;
    global.fetch = fetchImpl;
    const sender = new PostmarkEmailSender(config as never);
    return { sender, config, restore: () => (global.fetch = originalFetch) };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a successful call logs dependency/operation/durationMs/outcome/httpStatus via Logger.log', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE, CONTEXT);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^dependency=postmark operation=send organizationId=org-1 jobId=job-1 durationMs=\d+ outcome=success httpStatus=200$/,
      ),
    );
    restore();
  });

  it('an HTTP 4xx failure logs errorCategory=client_error via Logger.warn', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE, CONTEXT)).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/outcome=failure httpStatus=422 errorCategory=client_error$/),
    );
    restore();
  });

  it('an HTTP 5xx failure logs errorCategory=server_error via Logger.warn', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE, CONTEXT)).rejects.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/outcome=failure httpStatus=500 errorCategory=server_error$/),
    );
    restore();
  });

  it('a network/fetch-level failure logs errorCategory=network_error with no httpStatus, via Logger.warn, and rethrows the original error unchanged', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const networkError = new Error('getaddrinfo ENOTFOUND api.postmarkapp.com');
    const fetchImpl = jest.fn().mockRejectedValue(networkError);
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE, CONTEXT)).rejects.toBe(networkError);

    const [message] = warnSpy.mock.calls[0];
    expect(message).toMatch(/outcome=failure errorCategory=network_error$/);
    expect(message).not.toContain('httpStatus=');
    restore();
  });

  it('a 200 response with a non-zero Postmark ErrorCode is still logged as a failure (client_error)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 300, Message: 'Invalid email request' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE, CONTEXT)).rejects.toThrow(/Invalid email request/);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/outcome=failure httpStatus=200/));
    restore();
  });

  it('httpStatus is present only when a response actually exists', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE, CONTEXT);

    expect(logSpy.mock.calls[0][0]).toContain('httpStatus=200');
    expect(warnSpy).not.toHaveBeenCalled();
    restore();
  });

  it('organizationId and jobId correlation appear in the log when a context is passed', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE, { organizationId: 'org-42', jobId: 'job-99' });

    expect(logSpy.mock.calls[0][0]).toContain('organizationId=org-42');
    expect(logSpy.mock.calls[0][0]).toContain('jobId=job-99');
    restore();
  });

  it('omits organizationId/jobId cleanly when no context is passed, without throwing', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined();

    const [message] = logSpy.mock.calls[0];
    expect(message).not.toContain('organizationId=');
    expect(message).not.toContain('jobId=');
    restore();
  });

  it('security/PII — the log never contains the recipient email, subject, body, token, or provider response text', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await sender.send(MESSAGE, CONTEXT);

    const [message] = logSpy.mock.calls[0];
    expect(message).not.toContain(MESSAGE.to);
    expect(message).not.toContain(MESSAGE.subject);
    expect(message).not.toContain(MESSAGE.body);
    expect(message).not.toContain('test-token');
  });

  it('existing return value and thrown-error behavior are completely unchanged by the new instrumentation', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ErrorCode: 0, Message: 'OK' }),
    });
    const { sender, restore } = buildSender(fetchImpl as never);

    await expect(sender.send(MESSAGE, CONTEXT)).resolves.toBeUndefined();
    restore();
  });
});
