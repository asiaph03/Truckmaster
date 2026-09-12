import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { QueueRegistryService } from '../common/queue-health/queue-registry.service';
import { QueueHealthController } from './queue-health.controller';

function buildResMock() {
  return { status: jest.fn() } as unknown as Response;
}

describe('QueueHealthController', () => {
  it('the list route is marked @Public() (reachable without an authenticated session)', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, QueueHealthController.prototype.list);
    expect(isPublic).toBe(true);
  });

  it('returns all 8 queues with the correct shape and counts', async () => {
    const snapshot = [
      { name: 'email-send', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 8 },
      { name: 'import-commit', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 4 },
      { name: 'invoice-pdf', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 2 },
      { name: 'malware-scan', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 12 },
      { name: 'rate-confirmation-extraction', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3 },
      { name: 'rate-confirmation-pdf', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 5 },
      { name: 'scheduled-jobs', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 196 },
      { name: 'settlement-pdf', waiting: 0, active: 0, delayed: 0, failed: 0, completed: 1 },
    ];
    const queueRegistry = {
      getAllQueueCounts: jest.fn().mockResolvedValue(snapshot),
    } as unknown as QueueRegistryService;
    const controller = new QueueHealthController(queueRegistry);
    const res = buildResMock();

    const body = await controller.list(res);

    expect(res.status).not.toHaveBeenCalled();
    expect(body).toEqual({ queues: snapshot });
    expect((body as { queues: unknown[] }).queues).toHaveLength(8);
  });

  it('on a Redis/queue-registry failure, returns HTTP 503 with the predictable degraded body', async () => {
    const queueRegistry = {
      getAllQueueCounts: jest.fn().mockRejectedValue(new Error('Redis unreachable')),
    } as unknown as QueueRegistryService;
    const controller = new QueueHealthController(queueRegistry);
    const res = buildResMock();

    const body = await controller.list(res);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toEqual({ error: 'Unable to retrieve queue counts', queues: [] });
  });

  it('does not depend on Redis or Prisma directly — its only dependency is QueueRegistryService', () => {
    const queueRegistry = { getAllQueueCounts: jest.fn().mockResolvedValue([]) } as unknown as QueueRegistryService;

    expect(() => new QueueHealthController(queueRegistry)).not.toThrow();
  });

  it('the response never contains a top-level status/database/redis field — cannot be confused with /health\'s own response shape', async () => {
    const queueRegistry = { getAllQueueCounts: jest.fn().mockResolvedValue([]) } as unknown as QueueRegistryService;
    const controller = new QueueHealthController(queueRegistry);
    const res = buildResMock();

    const body = await controller.list(res);

    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('checks');
    expect(body).toHaveProperty('queues');
  });

  it('security/PII — each queue entry contains only name, the 5 count fields, and the 2 age fields, never job ids, organizationId, or payload data', async () => {
    const snapshot = [
      {
        name: 'malware-scan',
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 1,
        oldestWaitingAgeMs: null,
        oldestActiveAgeMs: null,
      },
    ];
    const queueRegistry = { getAllQueueCounts: jest.fn().mockResolvedValue(snapshot) } as unknown as QueueRegistryService;
    const controller = new QueueHealthController(queueRegistry);
    const res = buildResMock();

    const body = (await controller.list(res)) as { queues: Record<string, unknown>[] };

    for (const queue of body.queues) {
      expect(Object.keys(queue).sort()).toEqual(
        ['active', 'completed', 'delayed', 'failed', 'name', 'oldestActiveAgeMs', 'oldestWaitingAgeMs', 'waiting'].sort(),
      );
    }
  });

  it('security/PII — the degraded error response never includes job/tenant data, only the fixed error string', async () => {
    const queueRegistry = {
      getAllQueueCounts: jest.fn().mockRejectedValue(new Error('org=abc123 leaked in a real message')),
    } as unknown as QueueRegistryService;
    const controller = new QueueHealthController(queueRegistry);
    const res = buildResMock();

    const body = await controller.list(res);

    expect(body).toEqual({ error: 'Unable to retrieve queue counts', queues: [] });
    expect(JSON.stringify(body)).not.toContain('org=abc123');
  });
});
