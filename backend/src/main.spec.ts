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
  let processOnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();

    enableShutdownHooksMock = jest.fn();
    listenMock = jest.fn().mockResolvedValue(undefined);
    getMock = jest.fn().mockReturnValue({
      get: (key: string) => (key === 'port' ? 3000 : '127.0.0.1'),
    });
    loggerLogMock = jest.fn();

    class FakeLogger {
      constructor(public context?: string) {}
      log(message: string) {
        loggerLogMock(message);
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
});
