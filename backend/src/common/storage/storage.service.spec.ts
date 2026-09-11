import { Logger } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Monitoring Phase 4A-13 — S3 getObject/putObject timing/error attribution.
 * The constructor's S3Client() call is harmless (pure object construction,
 * no network I/O), so a real StorageService is built via `new` and only its
 * `client` field is swapped for a stub — matching the postmark-email-sender
 * spec's convention of never mocking framework internals that don't need it.
 */
function buildService(): { service: StorageService; client: { send: jest.Mock } } {
  const config = {
    get: jest.fn().mockReturnValue({
      bucket: 'test-bucket',
      endpoint: 'https://s3.test',
      region: 'us-east-1',
      forcePathStyle: true,
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    }),
  };
  const service = new StorageService(config as never);
  const client = { send: jest.fn() };
  (service as unknown as Record<string, unknown>).client = client;
  return { service, client };
}

function asyncBody(chunks: string[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

function mockDuration(startMs: number, endMs: number): jest.SpyInstance {
  return jest.spyOn(Date, 'now').mockReturnValueOnce(startMs).mockReturnValueOnce(endMs);
}

describe('StorageService — Monitoring Phase 4A-13 (S3 operation observability)', () => {
  const CONTEXT = { organizationId: 'org-1', jobId: 'job-1' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getObject', () => {
    it('logs event=s3_operation dependency=s3 operation=getObject ... outcome=success via Logger.log, and returns the bytes unchanged', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockResolvedValue({ Body: asyncBody(['hello ', 'world']) });
      mockDuration(1_000, 1_120);

      const result = await service.getObject('org_org-1/documents/doc-1', CONTEXT);

      expect(result).toEqual(Buffer.from('hello world'));
      expect(logSpy).toHaveBeenCalledWith(
        'event=s3_operation dependency=s3 operation=getObject organizationId=org-1 jobId=job-1 durationMs=120 outcome=success',
      );
    });

    it('on failure, logs outcome=failure with the correct errorCategory via Logger.warn, and rethrows the original error object unchanged', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      const originalError = Object.assign(new Error('access denied'), { $fault: 'client' });
      client.send.mockRejectedValue(originalError);
      mockDuration(1_000, 1_050);

      await expect(service.getObject('org_org-1/documents/doc-1', CONTEXT)).rejects.toBe(
        originalError,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        'event=s3_operation dependency=s3 operation=getObject organizationId=org-1 jobId=job-1 durationMs=50 outcome=failure errorCategory=client_error',
      );
    });

    it('omits organizationId/jobId cleanly when no context is passed, without throwing', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockResolvedValue({ Body: asyncBody(['x']) });
      mockDuration(1_000, 1_010);

      await service.getObject('org_org-1/documents/doc-1');

      const [message] = logSpy.mock.calls[0];
      expect(message).not.toContain('organizationId=');
      expect(message).not.toContain('jobId=');
      expect(message).toBe('event=s3_operation dependency=s3 operation=getObject durationMs=10 outcome=success');
    });
  });

  describe('putObject', () => {
    it('logs event=s3_operation dependency=s3 operation=putObject ... outcome=success via Logger.log, and resolves unchanged', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockResolvedValue(undefined);
      mockDuration(2_000, 2_075);

      await expect(
        service.putObject('org_org-1/documents/doc-1', Buffer.from('pdf'), 'application/pdf', CONTEXT),
      ).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        'event=s3_operation dependency=s3 operation=putObject organizationId=org-1 jobId=job-1 durationMs=75 outcome=success',
      );
    });

    it('on failure, logs outcome=failure with the correct errorCategory via Logger.warn, and rethrows the original error object unchanged', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      const originalError = Object.assign(new Error('internal error'), { $fault: 'server' });
      client.send.mockRejectedValue(originalError);
      mockDuration(2_000, 2_300);

      await expect(
        service.putObject('org_org-1/documents/doc-1', Buffer.from('pdf'), 'application/pdf', CONTEXT),
      ).rejects.toBe(originalError);

      expect(warnSpy).toHaveBeenCalledWith(
        'event=s3_operation dependency=s3 operation=putObject organizationId=org-1 jobId=job-1 durationMs=300 outcome=failure errorCategory=server_error',
      );
    });

    it('omits organizationId/jobId cleanly when no context is passed', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockResolvedValue(undefined);
      mockDuration(2_000, 2_005);

      await service.putObject('org_org-1/documents/doc-1', Buffer.from('pdf'), 'application/pdf');

      expect(logSpy).toHaveBeenCalledWith(
        'event=s3_operation dependency=s3 operation=putObject durationMs=5 outcome=success',
      );
    });
  });

  describe('errorCategory classification — coarse operational category, derived only from the typed $fault field', () => {
    it('$fault: "client" -> client_error', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockRejectedValue(Object.assign(new Error('x'), { $fault: 'client' }));
      mockDuration(1_000, 1_010);

      await expect(service.getObject('k')).rejects.toThrow();

      expect(warnSpy.mock.calls[0][0]).toContain('errorCategory=client_error');
    });

    it('$fault: "server" -> server_error', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockRejectedValue(Object.assign(new Error('x'), { $fault: 'server' }));
      mockDuration(1_000, 1_010);

      await expect(service.getObject('k')).rejects.toThrow();

      expect(warnSpy.mock.calls[0][0]).toContain('errorCategory=server_error');
    });

    it('a genuine Error with no $fault (e.g. a network-level failure) -> network_error', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockRejectedValue(new Error('getaddrinfo ENOTFOUND s3.test'));
      mockDuration(1_000, 1_010);

      await expect(service.getObject('k')).rejects.toThrow();

      expect(warnSpy.mock.calls[0][0]).toContain('errorCategory=network_error');
    });

    it('a thrown value that is neither $fault-bearing nor a genuine Error -> unknown', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockRejectedValue('a plain string was thrown');
      mockDuration(1_000, 1_010);

      await expect(service.getObject('k')).rejects.toBe('a plain string was thrown');

      expect(warnSpy.mock.calls[0][0]).toContain('errorCategory=unknown');
    });
  });

  describe('security/PII', () => {
    it('never logs the storage key, bucket name, file contents, error.message, error.stack, or any $metadata field', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client } = buildService();
      const sensitiveError = Object.assign(new Error('SECRET-MESSAGE-should-not-log'), {
        $fault: 'server',
        stack: 'STACK-TRACE-should-not-log',
        $metadata: {
          httpStatusCode: 500,
          requestId: 'REQUEST-ID-should-not-log',
          extendedRequestId: 'EXT-ID-should-not-log',
          cfId: 'CF-ID-should-not-log',
          attempts: 3,
          totalRetryDelay: 900,
        },
      });
      client.send.mockRejectedValue(sensitiveError);
      mockDuration(1_000, 1_010);

      await expect(
        service.getObject('org_org-1/documents/super-secret-key.pdf', CONTEXT),
      ).rejects.toBe(sensitiveError);

      const [message] = warnSpy.mock.calls[0];
      expect(message).not.toContain('super-secret-key');
      expect(message).not.toContain('test-bucket');
      expect(message).not.toContain('SECRET-MESSAGE-should-not-log');
      expect(message).not.toContain('STACK-TRACE-should-not-log');
      expect(message).not.toContain('REQUEST-ID-should-not-log');
      expect(message).not.toContain('EXT-ID-should-not-log');
      expect(message).not.toContain('CF-ID-should-not-log');
      expect(message).not.toContain('httpStatusCode');
      expect(message).not.toContain('requestId');
      expect(message).not.toContain('attempts');
      expect(message).not.toContain('totalRetryDelay');
      expect(message).not.toContain('$metadata');
      expect(message).toBe(
        'event=s3_operation dependency=s3 operation=getObject organizationId=org-1 jobId=job-1 durationMs=10 outcome=failure errorCategory=server_error',
      );
    });

    it('never logs file contents or a signed URL on the success path', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service, client } = buildService();
      client.send.mockResolvedValue({ Body: asyncBody(['SECRET-FILE-CONTENT']) });
      mockDuration(1_000, 1_010);

      await service.getObject('org_org-1/documents/doc-1', CONTEXT);

      const [message] = logSpy.mock.calls[0];
      expect(message).not.toContain('SECRET-FILE-CONTENT');
      expect(message).not.toContain('https://');
    });
  });
});
