import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { attachRedisErrorHandler, duplicateRedisWithErrorHandler } from './redis.module';

/**
 * Monitoring Phase 4A-1 — proves the defensive error-handler shape in
 * complete isolation from a real Redis server: `FakeRedisClient` only
 * needs to look like ioredis for the two things this module actually
 * calls (`duplicate()` and being an EventEmitter `on`/`emit` target), so
 * these tests never open a real connection and can run in any environment.
 */

class FakeRedisClient extends EventEmitter {
  duplicateCallCount = 0;
  duplicate(): FakeRedisClient {
    this.duplicateCallCount += 1;
    return new FakeRedisClient();
  }
}

describe('attachRedisErrorHandler', () => {
  it('attaches an error listener so emitting an Error does not crash the process', () => {
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'test-label');

    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('boom'))).not.toThrow();
  });

  it('logs the label and a safe, class-name-only errorType when an error is emitted', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'my-connection');

    const err = new Error('connection refused');
    client.emit('error', err);

    expect(errorSpy).toHaveBeenCalledWith(
      'event=redis_connection_error connection=my-connection errorType=Error',
    );
    errorSpy.mockRestore();
  });

  it('does not throw even when the emitted value has no stack (non-Error rejection shape)', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'label');

    expect(() => client.emit('error', { message: 'not a real Error' })).not.toThrow();
    errorSpy.mockRestore();
  });

  describe('Monitoring Phase 4A-21', () => {
    const SENSITIVE_MARKER = 'SENSITIVE_MARKER_f83a2c';

    it('never logs the sensitive marker even when it appears in both error.message and error.stack', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const client = new FakeRedisClient();
      attachRedisErrorHandler(client as unknown as import('ioredis').default, 'primary');

      const err = new Error(`Redis auth failed: ${SENSITIVE_MARKER}`);
      err.stack = `Error: Redis auth failed: ${SENSITIVE_MARKER}\n    at somewhere (${SENSITIVE_MARKER}.ts:1:1)`;
      client.emit('error', err);

      for (const call of errorSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(SENSITIVE_MARKER);
        }
      }
      errorSpy.mockRestore();
    });

    it('logs the safe event/connection/errorType format with a single string argument (primary connection)', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const client = new FakeRedisClient();
      attachRedisErrorHandler(client as unknown as import('ioredis').default, 'primary');

      const err = new Error(`Redis auth failed: ${SENSITIVE_MARKER}`);
      err.stack = `Error: Redis auth failed: ${SENSITIVE_MARKER}\n    at somewhere`;
      client.emit('error', err);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toHaveLength(1);
      const [message] = errorSpy.mock.calls[0];
      expect(message).toContain('event=redis_connection_error');
      expect(message).toContain('connection=primary');
      expect(message).toContain('errorType=Error');
      errorSpy.mockRestore();
    });

    it('logs the safe format for a non-Error thrown value using its runtime type as errorType', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const client = new FakeRedisClient();
      attachRedisErrorHandler(client as unknown as import('ioredis').default, 'primary');

      client.emit('error', `plain string with ${SENSITIVE_MARKER}`);

      expect(errorSpy.mock.calls[0]).toHaveLength(1);
      const [message] = errorSpy.mock.calls[0];
      expect(message).not.toContain(SENSITIVE_MARKER);
      expect(message).toContain('errorType=string');
      errorSpy.mockRestore();
    });
  });
});

describe('duplicateRedisWithErrorHandler', () => {
  it('calls duplicate() on the given client and returns the duplicate', () => {
    const source = new FakeRedisClient();
    const result = duplicateRedisWithErrorHandler(source as unknown as import('ioredis').default, 'label');

    expect(source.duplicateCallCount).toBe(1);
    expect(result).not.toBe(source);
  });

  it('attaches an error listener to the duplicate (not the source)', () => {
    const source = new FakeRedisClient();
    const result = duplicateRedisWithErrorHandler(
      source as unknown as import('ioredis').default,
      'label',
    ) as unknown as FakeRedisClient;

    expect(source.listenerCount('error')).toBe(0);
    expect(result.listenerCount('error')).toBe(1);
  });

  it('emitting an error on the duplicate does not crash and logs the given label in the safe format', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const source = new FakeRedisClient();
    const result = duplicateRedisWithErrorHandler(
      source as unknown as import('ioredis').default,
      'malware-scan-worker',
    ) as unknown as FakeRedisClient;

    const err = new Error('ECONNRESET');
    expect(() => result.emit('error', err)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      'event=redis_connection_error connection=malware-scan-worker errorType=Error',
    );
    errorSpy.mockRestore();
  });

  describe('Monitoring Phase 4A-21', () => {
    const SENSITIVE_MARKER = 'SENSITIVE_MARKER_f83a2c';

    it('never logs the sensitive marker for a worker duplicate connection, and logs a single safe argument', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const source = new FakeRedisClient();
      const result = duplicateRedisWithErrorHandler(
        source as unknown as import('ioredis').default,
        'rate-confirmation-extraction-worker',
      ) as unknown as FakeRedisClient;

      const err = new Error(`Redis auth failed: ${SENSITIVE_MARKER}`);
      err.stack = `Error: Redis auth failed: ${SENSITIVE_MARKER}\n    at somewhere (${SENSITIVE_MARKER}.ts:1:1)`;
      result.emit('error', err);

      expect(errorSpy.mock.calls[0]).toHaveLength(1);
      const [message] = errorSpy.mock.calls[0];
      expect(message).not.toContain(SENSITIVE_MARKER);
      expect(message).toContain('event=redis_connection_error');
      expect(message).toContain('connection=rate-confirmation-extraction-worker');
      expect(message).toContain('errorType=Error');
      errorSpy.mockRestore();
    });
  });
});
