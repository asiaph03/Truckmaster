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

  it('logs the label and message when an error is emitted', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'my-connection');

    const err = new Error('connection refused');
    client.emit('error', err);

    expect(errorSpy).toHaveBeenCalledWith(
      'Redis connection error (my-connection): connection refused',
      err.stack,
    );
    errorSpy.mockRestore();
  });

  it('passes stack information through when available', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'label');

    const err = new Error('with stack');
    client.emit('error', err);

    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), err.stack);
    expect(err.stack).toBeDefined();
    errorSpy.mockRestore();
  });

  it('does not throw even when the emitted value has no stack (non-Error rejection shape)', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = new FakeRedisClient();
    attachRedisErrorHandler(client as unknown as import('ioredis').default, 'label');

    expect(() => client.emit('error', { message: 'not a real Error' })).not.toThrow();
    errorSpy.mockRestore();
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

  it('emitting an error on the duplicate does not crash and logs the given label', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const source = new FakeRedisClient();
    const result = duplicateRedisWithErrorHandler(
      source as unknown as import('ioredis').default,
      'malware-scan-worker',
    ) as unknown as FakeRedisClient;

    const err = new Error('ECONNRESET');
    expect(() => result.emit('error', err)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      'Redis connection error (malware-scan-worker): ECONNRESET',
      err.stack,
    );
    errorSpy.mockRestore();
  });
});
