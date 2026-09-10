import { Logger } from '@nestjs/common';
import { ScheduledJobsWorker } from './scheduled-jobs.worker';

type Processor = (jobName: string) => Promise<void>;

let capturedProcessor: ((job: { name: string }) => Promise<void>) | undefined;
let capturedOn: jest.Mock | undefined;

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, processor: Processor) => {
    capturedProcessor = (job) => processor(job.name);
    capturedOn = jest.fn();
    return { on: capturedOn, close: jest.fn() };
  }),
  Queue: jest.fn(),
}));

/**
 * Monitoring Phase 4A-3 — this worker previously had no dedicated unit test
 * coverage at all (pre-existing gap, unrelated to this change). Scope here
 * is limited to the new worker-heartbeat wiring added in this phase — not
 * backfilling coverage for registerRepeatableJobs()/processJob()'s
 * pre-existing sweep-dispatch logic.
 */
describe('ScheduledJobsWorker — Monitoring Phase 4A-3 (worker heartbeat wiring)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const sweep = () => ({ run: jest.fn().mockResolvedValue(undefined) });
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    const worker = new ScheduledJobsWorker(
      redis as never,
      queue as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      heartbeat as never,
    );
    return { worker, queue, heartbeat };
  }

  it('registers itself with WorkerHeartbeatService on init', async () => {
    const { worker, heartbeat } = buildWorker();

    await worker.onModuleInit();

    expect(heartbeat.register).toHaveBeenCalledWith('scheduled-jobs-worker', expect.any(Function));
  });

  it("an 'active' event reports activity", async () => {
    const { worker, heartbeat } = buildWorker();
    await worker.onModuleInit();
    const activeHandler = capturedOn!.mock.calls.find((c) => c[0] === 'active')?.[1];
    expect(activeHandler).toBeDefined();

    activeHandler();

    expect(heartbeat.recordActivity).toHaveBeenCalledWith('scheduled-jobs-worker', 'active');
  });

  it("a 'completed' event reports activity", async () => {
    const { worker, heartbeat } = buildWorker();
    await worker.onModuleInit();
    const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];
    expect(completedHandler).toBeDefined();

    completedHandler({ name: 'invitation-expiration-sweep', id: 'job-1', processedOn: Date.now() - 50 });

    expect(heartbeat.recordActivity).toHaveBeenCalledWith('scheduled-jobs-worker', 'completed');
  });

  it("the existing 'failed' handler also reports activity (the worker is alive; only the sweep failed)", async () => {
    const { worker, heartbeat } = buildWorker();
    await worker.onModuleInit();
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    failedHandler({ name: 'invitation-expiration-sweep', id: 'job-1' }, new Error('boom'));

    expect(heartbeat.recordActivity).toHaveBeenCalledWith('scheduled-jobs-worker', 'failed');
  });

  it("a Worker-level 'error' event reports recordError, not recordActivity", async () => {
    const { worker, heartbeat } = buildWorker();
    await worker.onModuleInit();
    const errorHandler = capturedOn!.mock.calls.find((c) => c[0] === 'error')?.[1];
    expect(errorHandler).toBeDefined();

    errorHandler(new Error('connection lost'));

    expect(heartbeat.recordError).toHaveBeenCalledWith('scheduled-jobs-worker', 'error');
    expect(heartbeat.recordActivity).not.toHaveBeenCalledWith('scheduled-jobs-worker', 'error');
  });

  it('unregisters from WorkerHeartbeatService on shutdown', async () => {
    const { worker, heartbeat } = buildWorker();
    await worker.onModuleInit();

    await worker.onModuleDestroy();

    expect(heartbeat.unregister).toHaveBeenCalledWith('scheduled-jobs-worker');
  });
});

describe('ScheduledJobsWorker — Monitoring Phase 4A-4 (job duration logging)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const sweep = () => ({ run: jest.fn().mockResolvedValue(undefined) });
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    return new ScheduledJobsWorker(
      redis as never,
      queue as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      heartbeat as never,
    );
  }

  it("a 'completed' event logs a duration derived from job.processedOn — no organizationId, matching this queue's payload convention", async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];

    completedHandler({ name: 'invitation-expiration-sweep', id: 'job-1', processedOn: Date.now() - 250 });

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Scheduled job'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/^Scheduled job invitation-expiration-sweep \(job-1\) completed in \d+ms\.$/);
    expect(call![0]).not.toContain('org=');
    logSpy.mockRestore();
  });

  it('does not crash and omits the duration when job.processedOn is missing (unexpected event sequence)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const completedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'completed')?.[1];

    expect(() =>
      completedHandler({ name: 'invitation-expiration-sweep', id: 'job-1', processedOn: undefined }),
    ).not.toThrow();

    const call = logSpy.mock.calls.find((c) => String(c[0]).startsWith('Scheduled job'));
    expect(call![0]).toBe('Scheduled job invitation-expiration-sweep (job-1) completed.');
    logSpy.mockRestore();
  });

  it("includes duration in the 'failed' log (this queue's terminal-failure signal — no per-processor try/catch exists)", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    failedHandler(
      { name: 'invitation-expiration-sweep', id: 'job-1', processedOn: Date.now() - 400 },
      new Error('boom'),
    );

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Scheduled job'));
    expect(call).toBeDefined();
    expect(call![0]).toMatch(/^Scheduled job invitation-expiration-sweep \(job-1\) failed \(\d+ms\): boom$/);
    errorSpy.mockRestore();
  });

  it("does not crash and omits the duration in the 'failed' log when job is undefined (stalled-job-removed-by-removeOnFail edge case)", async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const failedHandler = capturedOn!.mock.calls.find((c) => c[0] === 'failed')?.[1];

    expect(() => failedHandler(undefined, new Error('boom'))).not.toThrow();

    const call = errorSpy.mock.calls.find((c) => String(c[0]).startsWith('Scheduled job'));
    expect(call![0]).toBe('Scheduled job undefined (undefined) failed: boom');
    errorSpy.mockRestore();
  });
});

describe('ScheduledJobsWorker — Monitoring Phase 4A-5 (stalled-event observability)', () => {
  function buildWorker() {
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const sweep = () => ({ run: jest.fn().mockResolvedValue(undefined) });
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };

    return new ScheduledJobsWorker(
      redis as never,
      queue as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      heartbeat as never,
    );
  }

  it("a 'stalled' event logs a warning with the worker label, jobId, and prev state", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];
    expect(stalledHandler).toBeDefined();

    stalledHandler('job-42', 'active');

    expect(warnSpy).toHaveBeenCalledWith('Scheduled job job-42 stalled (was active).');
    warnSpy.mockRestore();
  });

  it('does not touch WorkerHeartbeatService in any way', async () => {
    const heartbeat = {
      register: jest.fn(),
      unregister: jest.fn(),
      recordActivity: jest.fn(),
      recordError: jest.fn(),
    };
    capturedProcessor = undefined;
    const redis = { duplicate: jest.fn().mockReturnValue({ on: jest.fn(), quit: jest.fn() }) };
    const queue = { add: jest.fn().mockResolvedValue({}) };
    const sweep = () => ({ run: jest.fn().mockResolvedValue(undefined) });
    const worker = new ScheduledJobsWorker(
      redis as never,
      queue as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      sweep() as never,
      heartbeat as never,
    );
    await worker.onModuleInit();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];

    stalledHandler('job-42', 'active');

    expect(heartbeat.recordActivity).not.toHaveBeenCalled();
    expect(heartbeat.recordError).not.toHaveBeenCalled();
    expect(heartbeat.register).toHaveBeenCalledTimes(1);
    expect(heartbeat.unregister).not.toHaveBeenCalled();
  });

  it('security/PII — the stalled log contains only jobId and prev, never job data', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const worker = buildWorker();
    await worker.onModuleInit();
    const stalledHandler = capturedOn!.mock.calls.find((c) => c[0] === 'stalled')?.[1];

    stalledHandler('job-42', 'active');

    const [message] = warnSpy.mock.calls[0];
    expect(message).toBe('Scheduled job job-42 stalled (was active).');
    expect(message).not.toMatch(/org[a-zA-Z]*=/i);
    warnSpy.mockRestore();
  });
});
