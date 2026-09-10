/**
 * Monitoring Phase 4A-8 — main.ts runs bootstrap() unconditionally on
 * import, so every dependency that would otherwise touch real
 * infrastructure (Nest app creation, session/Redis wiring in
 * configure-app.ts) is mocked before a fresh import via jest.doMock() +
 * jest.resetModules(), matching the standard pattern for testing a
 * fire-and-forget entrypoint file.
 *
 * Logger is faked (not spied via Logger.prototype) because
 * jest.resetModules() gives the dynamically re-imported main.ts a fresh
 * copy of '@nestjs/common' on each test — a prototype spy taken from this
 * file's own top-level import would be a different copy and silently miss
 * every call.
 */
describe('main.ts bootstrap — Monitoring Phase 4A-8 (graceful shutdown)', () => {
  let enableShutdownHooksMock: jest.Mock;
  let listenMock: jest.Mock;
  let getMock: jest.Mock;
  let loggerLogMock: jest.Mock;
  let loggerErrorMock: jest.Mock;
  let processOnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();

    enableShutdownHooksMock = jest.fn();
    listenMock = jest.fn().mockResolvedValue(undefined);
    getMock = jest.fn().mockReturnValue({
      get: (key: string) => (key === 'port' ? 3000 : '127.0.0.1'),
    });
    loggerLogMock = jest.fn();
    loggerErrorMock = jest.fn();

    class FakeLogger {
      constructor(public context?: string) {}
      log(message: string) {
        loggerLogMock(message);
      }
      error(message: string, stack?: string) {
        loggerErrorMock(message, stack);
      }
    }

    jest.doMock('@nestjs/common', () => ({
      ...jest.requireActual('@nestjs/common'),
      Logger: FakeLogger,
    }));
    jest.doMock('@nestjs/core', () => ({
      NestFactory: {
        create: jest.fn().mockResolvedValue({
          enableShutdownHooks: enableShutdownHooksMock,
          listen: listenMock,
          get: getMock,
        }),
      },
    }));
    jest.doMock('./configure-app', () => ({ configureApp: jest.fn() }));
    jest.doMock('./app.module', () => ({ AppModule: class {} }));

    processOnSpy = jest.spyOn(process, 'on');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    // process.on('SIGTERM'/'SIGINT', ...) registers on the real, shared
    // process object — clean up after each test so listeners never
    // accumulate across this file's tests.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  });

  async function loadMain(): Promise<void> {
    await import('./main');
    // Flush the fire-and-forget bootstrap() promise chain.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('calls app.enableShutdownHooks() during bootstrap', async () => {
    await loadMain();

    expect(enableShutdownHooksMock).toHaveBeenCalled();
  });

  it('registers a SIGTERM handler', async () => {
    await loadMain();

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('registers a SIGINT handler', async () => {
    await loadMain();

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('the SIGTERM handler logs "graceful shutdown initiated" and never calls process.exit()', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await loadMain();
    const handler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM')?.[1] as () => void;
    expect(handler).toBeDefined();

    handler();

    expect(loggerLogMock).toHaveBeenCalledWith(expect.stringContaining('graceful shutdown initiated'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('the SIGINT handler also logs "graceful shutdown initiated" and never calls process.exit()', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await loadMain();
    const handler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')?.[1] as () => void;
    expect(handler).toBeDefined();

    handler();

    expect(loggerLogMock).toHaveBeenCalledWith(expect.stringContaining('graceful shutdown initiated'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('existing startup behavior remains intact — app.listen() is still called with the configured port/host', async () => {
    await loadMain();

    expect(listenMock).toHaveBeenCalledWith(3000, '127.0.0.1');
  });

  it('security/PII — the shutdown log contains only the signal name, no request/job/org/user data', async () => {
    jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await loadMain();
    const handler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM')?.[1] as () => void;
    handler();

    expect(loggerLogMock).toHaveBeenCalledWith('graceful shutdown initiated (SIGTERM)');
  });

  describe('Monitoring Phase 4A-9 (process-level fatal error logging)', () => {
    it('registers exactly one unhandledRejection handler', async () => {
      await loadMain();

      const calls = processOnSpy.mock.calls.filter((c) => c[0] === 'unhandledRejection');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(expect.any(Function));
    });

    it('registers exactly one uncaughtException handler', async () => {
      await loadMain();

      const calls = processOnSpy.mock.calls.filter((c) => c[0] === 'uncaughtException');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(expect.any(Function));
    });

    it('does not introduce duplicate SIGTERM/SIGINT registrations alongside the new handlers', async () => {
      await loadMain();

      expect(processOnSpy.mock.calls.filter((c) => c[0] === 'SIGTERM')).toHaveLength(1);
      expect(processOnSpy.mock.calls.filter((c) => c[0] === 'SIGINT')).toHaveLength(1);
      expect(processOnSpy.mock.calls.filter((c) => c[0] === 'unhandledRejection')).toHaveLength(1);
      expect(processOnSpy.mock.calls.filter((c) => c[0] === 'uncaughtException')).toHaveLength(1);
    });

    it('unhandledRejection logs the event type and message, then calls process.exit(1)', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'unhandledRejection')?.[1] as (
        reason: unknown,
      ) => void;
      expect(handler).toBeDefined();

      handler(new Error('database pool exhausted'));

      expect(loggerErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('unhandledRejection: database pool exhausted'),
        expect.any(String),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('unhandledRejection includes the stack when the reason is a real Error', async () => {
      jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const error = new Error('boom');

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'unhandledRejection')?.[1] as (
        reason: unknown,
      ) => void;

      handler(error);

      expect(loggerErrorMock).toHaveBeenCalledWith(expect.any(String), error.stack);
    });

    it('uncaughtException logs the event type and message, then calls process.exit(1)', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'uncaughtException')?.[1] as (
        error: unknown,
      ) => void;
      expect(handler).toBeDefined();

      handler(new Error('unexpected null reference'));

      expect(loggerErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('uncaughtException: unexpected null reference'),
        expect.any(String),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('uncaughtException includes the stack', async () => {
      jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const error = new Error('fatal');

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'uncaughtException')?.[1] as (
        error: unknown,
      ) => void;

      handler(error);

      expect(loggerErrorMock).toHaveBeenCalledWith(expect.any(String), error.stack);
    });

    it('process.exit is mocked and never actually terminates the test process', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'uncaughtException')?.[1] as (
        error: unknown,
      ) => void;

      expect(() => handler(new Error('boom'))).not.toThrow();
      expect(exitSpy).toHaveBeenCalled();
    });

    it.each([
      ['a string reason', 'plain string rejection'],
      ['an object reason', { code: 'EFATAL' }],
      ['a null reason', null],
      ['an undefined reason', undefined],
    ])('handles a non-Error unhandledRejection reason (%s) without itself throwing', async (_label, reason) => {
      jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'unhandledRejection')?.[1] as (
        r: unknown,
      ) => void;

      expect(() => handler(reason)).not.toThrow();
      expect(loggerErrorMock).toHaveBeenCalled();
    });

    it('security/PII — the fatal log never contains request/job/org/user data, only event type, message, pid, and uptime', async () => {
      jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const handler = processOnSpy.mock.calls.find((c) => c[0] === 'uncaughtException')?.[1] as (
        error: unknown,
      ) => void;

      handler(new Error('safe message only'));

      const [message] = loggerErrorMock.mock.calls[0];
      expect(message).toContain('uncaughtException: safe message only');
      expect(message).toMatch(/pid=\d+/);
      expect(message).toMatch(/uptime=\d+(\.\d+)?s/);
      expect(message).not.toMatch(/org[a-zA-Z]*=/i);
      expect(message).not.toMatch(/user[a-zA-Z]*=/i);
      expect(message).not.toMatch(/@/);
      expect(message).not.toMatch(/authorization|bearer|password|token|cookie/i);
    });

    it('4A-8 SIGTERM/SIGINT behavior remains unchanged alongside the new handlers', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await loadMain();
      const sigtermHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM')?.[1] as () => void;

      sigtermHandler();

      expect(loggerLogMock).toHaveBeenCalledWith('graceful shutdown initiated (SIGTERM)');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
