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
});
