import {
  WorkerHeartbeatService,
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
} from './worker-heartbeat.service';

describe('WorkerHeartbeatService', () => {
  let service: WorkerHeartbeatService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new WorkerHeartbeatService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('1. registering a worker creates an entry reported as STARTING', () => {
    service.register('malware-scan-worker', () => true);

    expect(service.getSnapshot('malware-scan-worker')).toEqual({
      name: 'malware-scan-worker',
      status: 'STARTING',
      lastSeenAt: null,
      lastEventType: null,
    });
  });

  it('2. STARTING never has a lastSeenAt or lastEventType', () => {
    service.register('email-send-worker', () => true);

    const snapshot = service.getSnapshot('email-send-worker')!;
    expect(snapshot.lastSeenAt).toBeNull();
    expect(snapshot.lastEventType).toBeNull();
  });

  it('3. the first periodic tick transitions STARTING -> HEALTHY', () => {
    service.register('email-send-worker', () => true);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    const snapshot = service.getSnapshot('email-send-worker')!;
    expect(snapshot.status).toBe('HEALTHY');
    expect(snapshot.lastEventType).toBe('tick');
    expect(snapshot.lastSeenAt).not.toBeNull();
  });

  it('4. an active event updates the heartbeat and reports HEALTHY', () => {
    service.register('malware-scan-worker', () => true);

    service.recordActivity('malware-scan-worker', 'active');

    const snapshot = service.getSnapshot('malware-scan-worker')!;
    expect(snapshot.status).toBe('HEALTHY');
    expect(snapshot.lastEventType).toBe('active');
  });

  it('5. a completed event updates the heartbeat', () => {
    service.register('malware-scan-worker', () => true);

    service.recordActivity('malware-scan-worker', 'completed');

    expect(service.getSnapshot('malware-scan-worker')!.lastEventType).toBe('completed');
  });

  it('6. a failed event updates the heartbeat — the worker is still alive, only the job failed', () => {
    service.register('malware-scan-worker', () => true);

    service.recordActivity('malware-scan-worker', 'failed');

    const snapshot = service.getSnapshot('malware-scan-worker')!;
    expect(snapshot.status).toBe('HEALTHY');
    expect(snapshot.lastEventType).toBe('failed');
  });

  it('7. / 16. an idle worker (zero jobs, ever) stays HEALTHY via the periodic tick alone across many intervals', () => {
    service.register('scheduled-jobs-worker', () => true);

    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(service.getSnapshot('scheduled-jobs-worker')!.status).toBe('HEALTHY');
    }
  });

  it('8. becomes STALE only after the sustained threshold with no activity or successful tick', () => {
    service.register('email-send-worker', () => false); // isRunning() false — ticks never mark activity
    service.recordActivity('email-send-worker', 'active'); // establish an initial timestamp

    jest.advanceTimersByTime(STALE_THRESHOLD_MS + 1);

    expect(service.getSnapshot('email-send-worker')!.status).toBe('STALE');
  });

  it('9. does not go STALE prematurely, just under the threshold', () => {
    service.register('email-send-worker', () => false);
    service.recordActivity('email-send-worker', 'active');

    jest.advanceTimersByTime(STALE_THRESHOLD_MS - 1);

    expect(service.getSnapshot('email-send-worker')!.status).toBe('HEALTHY');
  });

  it('10. an explicit Worker error reports ERROR, independent of the staleness clock', () => {
    service.register('malware-scan-worker', () => true);

    service.recordError('malware-scan-worker', 'error');

    const snapshot = service.getSnapshot('malware-scan-worker')!;
    expect(snapshot.status).toBe('ERROR');
    expect(snapshot.lastEventType).toBe('error');
  });

  it('10b. a fresh activity event clears a prior ERROR back to HEALTHY', () => {
    service.register('malware-scan-worker', () => true);
    service.recordError('malware-scan-worker', 'error');

    service.recordActivity('malware-scan-worker', 'active');

    expect(service.getSnapshot('malware-scan-worker')!.status).toBe('HEALTHY');
  });

  it('11. multiple workers are tracked independently', () => {
    service.register('malware-scan-worker', () => true);
    service.register('email-send-worker', () => true);

    service.recordError('malware-scan-worker', 'error');
    service.recordActivity('email-send-worker', 'active');

    expect(service.getSnapshot('malware-scan-worker')!.status).toBe('ERROR');
    expect(service.getSnapshot('email-send-worker')!.status).toBe('HEALTHY');
  });

  it('12. unregister (worker shutdown) removes it from reported snapshots', () => {
    service.register('malware-scan-worker', () => true);
    service.recordActivity('malware-scan-worker', 'active');
    expect(service.getAllSnapshots()).toHaveLength(1);

    service.unregister('malware-scan-worker');

    expect(service.getSnapshot('malware-scan-worker')).toBeUndefined();
    expect(service.getAllSnapshots()).toHaveLength(0);
  });

  it('getAllSnapshots returns every registered worker, sorted by name', () => {
    service.register('settlement-pdf-worker', () => true);
    service.register('email-send-worker', () => true);

    expect(service.getAllSnapshots().map((s) => s.name)).toEqual([
      'email-send-worker',
      'settlement-pdf-worker',
    ]);
  });

  it('the periodic tick only marks activity for a worker whose isRunning() returns true', () => {
    service.register('malware-scan-worker', () => false);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(service.getSnapshot('malware-scan-worker')!.status).toBe('STARTING');
  });

  it('security/PII — a snapshot never contains anything beyond name/status/lastSeenAt/lastEventType', () => {
    service.register('malware-scan-worker', () => true);
    service.recordActivity('malware-scan-worker', 'active');

    const snapshot = service.getSnapshot('malware-scan-worker')!;
    expect(Object.keys(snapshot).sort()).toEqual(['lastEventType', 'lastSeenAt', 'name', 'status']);
  });
});
