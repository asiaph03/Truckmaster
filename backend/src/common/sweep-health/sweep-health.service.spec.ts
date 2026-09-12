import { Logger } from '@nestjs/common';
import { SweepHealthService, SweepScheduleDefinition } from './sweep-health.service';

const DAILY_DEFINITION: SweepScheduleDefinition = {
  name: 'invitation-expiration-sweep',
  cadence: 'DAILY',
  schedule: '0 3 * * *',
  timezone: 'America/New_York',
};

const OPERATIONAL_DEFINITION: SweepScheduleDefinition = {
  name: 'check-call-reminder-sweep',
  cadence: 'OPERATIONAL',
  schedule: 'every 15 minutes',
  timezone: null,
};

function buildService(redisOverrides: Partial<Record<'hset' | 'hgetall', jest.Mock>> = {}) {
  const redis = {
    hset: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn().mockResolvedValue({}),
    ...redisOverrides,
  };
  const service = new SweepHealthService(redis as never);
  return { service, redis };
}

describe('SweepHealthService — Monitoring Phase 4A-23D', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('recordSuccess', () => {
    it('writes lastAttemptAt and lastSuccessAt to the same instant, keyed by sweep name', async () => {
      const { service, redis } = buildService();

      await service.recordSuccess('invitation-expiration-sweep', 1_000);

      expect(redis.hset).toHaveBeenCalledWith('sweep-health:invitation-expiration-sweep', {
        lastAttemptAt: 1_000,
        lastSuccessAt: 1_000,
      });
    });

    it('is best-effort — a Redis failure is swallowed, never thrown', async () => {
      const { service } = buildService({ hset: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.recordSuccess('invitation-expiration-sweep', 1_000)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'event=sweep_health_write_failed sweep=invitation-expiration-sweep outcome=success errorType=Error',
      );
    });

    it('SECURITY — never logs a sensitive marker present in a write failure error', async () => {
      const SENSITIVE_MARKER = 'SENSITIVE_REDIS_ERROR_CONTENT';
      const err = Object.assign(new Error(SENSITIVE_MARKER), { stack: `Error: ${SENSITIVE_MARKER}` });
      const { service } = buildService({ hset: jest.fn().mockRejectedValue(err) });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await service.recordSuccess('invitation-expiration-sweep', 1_000);

      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(SENSITIVE_MARKER);
        }
      }
    });
  });

  describe('recordFailure', () => {
    it('writes only lastAttemptAt, leaving lastSuccessAt untouched', async () => {
      const { service, redis } = buildService();

      await service.recordFailure('quote-expiration-sweep', 2_000);

      expect(redis.hset).toHaveBeenCalledWith('sweep-health:quote-expiration-sweep', {
        lastAttemptAt: 2_000,
      });
      expect(redis.hset).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ lastSuccessAt: expect.anything() }),
      );
    });

    it('is best-effort — a Redis failure is swallowed, never thrown', async () => {
      const { service } = buildService({ hset: jest.fn().mockRejectedValue(new Error('boom')) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.recordFailure('quote-expiration-sweep', 2_000)).resolves.toBeUndefined();
    });
  });

  describe('getSnapshot', () => {
    it('returns the explicit "unknown" shape when no state has ever been recorded', async () => {
      const { service } = buildService({ hgetall: jest.fn().mockResolvedValue({}) });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, 10_000);

      expect(snapshot).toEqual({
        sweepName: 'invitation-expiration-sweep',
        schedule: '0 3 * * *',
        timezone: 'America/New_York',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastAttemptSucceeded: null,
        overdue: null,
      });
    });

    it('reports lastAttemptSucceeded=true when lastAttemptAt equals lastSuccessAt', async () => {
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: '1000', lastSuccessAt: '1000' }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, 1_000);

      expect(snapshot.lastAttemptSucceeded).toBe(true);
      expect(snapshot.lastAttemptAt).toBe(new Date(1000).toISOString());
      expect(snapshot.lastSuccessAt).toBe(new Date(1000).toISOString());
    });

    it('reports lastAttemptSucceeded=false when the latest attempt failed after an earlier success', async () => {
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: '2000', lastSuccessAt: '1000' }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, 2_000);

      expect(snapshot.lastAttemptSucceeded).toBe(false);
    });

    it('a daily sweep is not overdue at exactly the 27-hour boundary minus one', async () => {
      const lastSuccessAt = 0;
      const now = 27 * 60 * 60 * 1000 - 1;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, now);

      expect(snapshot.overdue).toBe(false);
    });

    it('a daily sweep is overdue past 27 hours since lastSuccessAt', async () => {
      const lastSuccessAt = 0;
      const now = 27 * 60 * 60 * 1000 + 1;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, now);

      expect(snapshot.overdue).toBe(true);
    });

    it('a daily sweep survives the 25-hour DST fall-back extreme without false-flagging overdue', async () => {
      const lastSuccessAt = 0;
      const now = 25 * 60 * 60 * 1000;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, now);

      expect(snapshot.overdue).toBe(false);
    });

    it('an operational sweep is not overdue at exactly the 45-minute boundary minus one', async () => {
      const lastSuccessAt = 0;
      const now = 45 * 60 * 1000 - 1;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(OPERATIONAL_DEFINITION, now);

      expect(snapshot.overdue).toBe(false);
    });

    it('an operational sweep is overdue past 45 minutes since lastSuccessAt', async () => {
      const lastSuccessAt = 0;
      const now = 45 * 60 * 1000 + 1;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(OPERATIONAL_DEFINITION, now);

      expect(snapshot.overdue).toBe(true);
    });

    it('a single missed 15-minute tick (20 minutes of silence) does not false-positive', async () => {
      const lastSuccessAt = 0;
      const now = 20 * 60 * 1000;
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: String(lastSuccessAt), lastSuccessAt: String(lastSuccessAt) }),
      });

      const snapshot = await service.getSnapshot(OPERATIONAL_DEFINITION, now);

      expect(snapshot.overdue).toBe(false);
    });

    it('returns the "unknown" shape (never overdue=true) when Redis is unreachable at read time', async () => {
      const { service } = buildService({ hgetall: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, 10_000);

      expect(snapshot.overdue).toBeNull();
      expect(snapshot.lastAttemptSucceeded).toBeNull();
      expect(snapshot.lastAttemptAt).toBeNull();
      expect(snapshot.lastSuccessAt).toBeNull();
    });

    it('never throws on a Redis read failure', async () => {
      const { service } = buildService({ hgetall: jest.fn().mockRejectedValue(new Error('boom')) });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.getSnapshot(DAILY_DEFINITION)).resolves.toBeDefined();
    });

    it('security/PII — the snapshot never contains organizationId, job payload, or error content', async () => {
      const { service } = buildService({
        hgetall: jest.fn().mockResolvedValue({ lastAttemptAt: '1000', lastSuccessAt: '1000' }),
      });

      const snapshot = await service.getSnapshot(DAILY_DEFINITION, 1_000);

      expect(Object.keys(snapshot).sort()).toEqual(
        ['lastAttemptAt', 'lastAttemptSucceeded', 'lastSuccessAt', 'overdue', 'schedule', 'sweepName', 'timezone'].sort(),
      );
    });

    it('keeps two sweeps fully isolated — reading one never reflects the other\'s state', async () => {
      const hgetall = jest.fn().mockImplementation((key: string) => {
        if (key === 'sweep-health:invitation-expiration-sweep') {
          return Promise.resolve({ lastAttemptAt: '1000', lastSuccessAt: '1000' });
        }
        return Promise.resolve({});
      });
      const { service } = buildService({ hgetall });

      const invitationSnapshot = await service.getSnapshot(DAILY_DEFINITION, 1_000);
      const checkCallSnapshot = await service.getSnapshot(OPERATIONAL_DEFINITION, 1_000);

      expect(invitationSnapshot.lastSuccessAt).not.toBeNull();
      expect(checkCallSnapshot.lastSuccessAt).toBeNull();
    });
  });
});
