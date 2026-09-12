import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { SweepHealthService, SweepHealthSnapshot } from '../common/sweep-health/sweep-health.service';
import { SweepHealthController } from './sweep-health.controller';

function unknownSnapshot(sweepName: string, schedule: string, timezone: string | null): SweepHealthSnapshot {
  return {
    sweepName,
    schedule,
    timezone,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastAttemptSucceeded: null,
    overdue: null,
  };
}

describe('SweepHealthController — Monitoring Phase 4A-23D', () => {
  it('the list route is marked @Public() (reachable without an authenticated session)', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, SweepHealthController.prototype.list);
    expect(isPublic).toBe(true);
  });

  it('returns all 6 sweeps', async () => {
    const sweepHealth = {
      getSnapshot: jest.fn().mockImplementation((definition) =>
        Promise.resolve(unknownSnapshot(definition.name, definition.schedule, definition.timezone)),
      ),
    } as unknown as SweepHealthService;
    const controller = new SweepHealthController(sweepHealth);

    const body = await controller.list();

    expect(body.sweeps).toHaveLength(6);
  });

  it('includes the 4 daily sweeps pinned to America/New_York and the 2 operational sweeps with no timezone', async () => {
    const sweepHealth = {
      getSnapshot: jest.fn().mockImplementation((definition) =>
        Promise.resolve(unknownSnapshot(definition.name, definition.schedule, definition.timezone)),
      ),
    } as unknown as SweepHealthService;
    const controller = new SweepHealthController(sweepHealth);

    const body = await controller.list();

    const dailyNames = [
      'invitation-expiration-sweep',
      'quote-expiration-sweep',
      'carrier-compliance-expiration-sweep',
      'compliance-expiration-notifications',
    ];
    const operationalNames = ['check-call-reminder-sweep', 'load-lateness-sweep'];

    for (const name of dailyNames) {
      const sweep = body.sweeps.find((s) => s.sweepName === name)!;
      expect(sweep).toBeDefined();
      expect(sweep.timezone).toBe('America/New_York');
      expect(sweep.schedule).toBe('0 3 * * *');
    }
    for (const name of operationalNames) {
      const sweep = body.sweeps.find((s) => s.sweepName === name)!;
      expect(sweep).toBeDefined();
      expect(sweep.timezone).toBeNull();
    }
  });

  it('never returns a 500 — always resolves even when every snapshot is "unknown"', async () => {
    const sweepHealth = {
      getSnapshot: jest.fn().mockResolvedValue({
        sweepName: 'x',
        schedule: 'x',
        timezone: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastAttemptSucceeded: null,
        overdue: null,
      }),
    } as unknown as SweepHealthService;
    const controller = new SweepHealthController(sweepHealth);

    await expect(controller.list()).resolves.toBeDefined();
  });

  it('security/PII — each sweep entry contains only the 7 documented fields, never organizationId or job payload', async () => {
    const sweepHealth = {
      getSnapshot: jest.fn().mockImplementation((definition) =>
        Promise.resolve(unknownSnapshot(definition.name, definition.schedule, definition.timezone)),
      ),
    } as unknown as SweepHealthService;
    const controller = new SweepHealthController(sweepHealth);

    const body = await controller.list();

    for (const sweep of body.sweeps) {
      expect(Object.keys(sweep).sort()).toEqual(
        ['lastAttemptAt', 'lastAttemptSucceeded', 'lastSuccessAt', 'overdue', 'schedule', 'sweepName', 'timezone'].sort(),
      );
    }
  });

  it('the response never contains a top-level status/database/redis field — cannot be confused with /health\'s own response shape', async () => {
    const sweepHealth = {
      getSnapshot: jest.fn().mockImplementation((definition) =>
        Promise.resolve(unknownSnapshot(definition.name, definition.schedule, definition.timezone)),
      ),
    } as unknown as SweepHealthService;
    const controller = new SweepHealthController(sweepHealth);

    const body = await controller.list();

    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('checks');
    expect(body).toHaveProperty('sweeps');
  });
});
