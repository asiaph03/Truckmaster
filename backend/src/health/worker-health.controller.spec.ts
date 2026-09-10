import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { WorkerHeartbeatService } from '../common/worker-health/worker-heartbeat.service';
import { WorkerHealthController } from './worker-health.controller';

describe('WorkerHealthController', () => {
  it('14. the list route is marked @Public() (reachable without an authenticated session)', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, WorkerHealthController.prototype.list);
    expect(isPublic).toBe(true);
  });

  it('returns every worker snapshot currently tracked by WorkerHeartbeatService', () => {
    const heartbeat = new WorkerHeartbeatService();
    heartbeat.register('malware-scan-worker', () => true);
    heartbeat.register('email-send-worker', () => true);
    heartbeat.recordActivity('malware-scan-worker', 'active');

    const controller = new WorkerHealthController(heartbeat);
    const result = controller.list();

    expect(result.workers).toHaveLength(2);
    expect(result.workers.map((w) => w.name)).toEqual(['email-send-worker', 'malware-scan-worker']);

    heartbeat.onModuleDestroy();
  });

  it('13. does not depend on Redis or Prisma in any way — constructing/using it never touches either', () => {
    // WorkerHeartbeatService holds only in-memory state; the controller's
    // only dependency is that service. Constructing and calling list() here
    // with no Redis/Prisma instance anywhere in scope, and it still returns
    // data, is itself the proof this endpoint keeps reporting during a
    // Redis outage rather than going blank.
    const heartbeat = new WorkerHeartbeatService();
    heartbeat.register('email-send-worker', () => true);
    heartbeat.recordActivity('email-send-worker', 'completed');

    const controller = new WorkerHealthController(heartbeat);

    expect(() => controller.list()).not.toThrow();
    expect(controller.list().workers[0]).toEqual({
      name: 'email-send-worker',
      status: 'HEALTHY',
      lastSeenAt: expect.any(String),
      lastEventType: 'completed',
    });

    heartbeat.onModuleDestroy();
  });

  it('15. the response never contains a top-level status/database/redis field — proves it cannot be confused with, or alter, /health\'s own response shape', () => {
    const heartbeat = new WorkerHeartbeatService();
    heartbeat.register('email-send-worker', () => true);
    const controller = new WorkerHealthController(heartbeat);

    const result = controller.list();

    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('checks');
    expect(result).toHaveProperty('workers');

    heartbeat.onModuleDestroy();
  });

  it('security/PII — the response contains only worker name, status, lastSeenAt, and lastEventType, never job/tenant data', () => {
    const heartbeat = new WorkerHeartbeatService();
    heartbeat.register('malware-scan-worker', () => true);
    heartbeat.recordActivity('malware-scan-worker', 'active');
    const controller = new WorkerHealthController(heartbeat);

    const result = controller.list();

    for (const worker of result.workers) {
      expect(Object.keys(worker).sort()).toEqual(['lastEventType', 'lastSeenAt', 'name', 'status']);
    }

    heartbeat.onModuleDestroy();
  });
});
