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

    completedHandler();

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
