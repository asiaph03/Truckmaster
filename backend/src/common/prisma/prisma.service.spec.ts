import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const TOKEN_HASH = 'a'.repeat(64);

/**
 * Monitoring Phase 4A-12 — PrismaService extends PrismaClient, and
 * constructing a real instance would attempt to validate a live database
 * connection this unit test suite has no fixture for (matching every
 * other spec file's convention of never constructing a real
 * PrismaService). Object.create() produces a real object on
 * PrismaService's own prototype chain — so withTenantTransaction /
 * withUserTransaction / withInvitationTokenTransaction and the private
 * logSlowTransaction helper are all real, unmocked methods under test —
 * without ever running PrismaClient's constructor. Class field
 * initializers (the `logger` field) don't run without the constructor,
 * so it's assigned manually below.
 */
function buildService(): PrismaService {
  const service = Object.create(PrismaService.prototype) as PrismaService;
  (service as unknown as Record<string, unknown>).logger = new Logger(PrismaService.name);
  return service;
}

function mockTransaction(service: PrismaService, error?: unknown) {
  (service as unknown as { $transaction: jest.Mock }).$transaction = jest
    .fn()
    .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (error) throw error;
      const tx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };
      return fn(tx);
    });
}

function mockDuration(startMs: number, endMs: number): jest.SpyInstance {
  return jest.spyOn(Date, 'now').mockReturnValueOnce(startMs).mockReturnValueOnce(endMs);
}

describe('PrismaService — Monitoring Phase 4A-12 (slow transaction logging)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a fast withTenantTransaction (<250ms) does not log', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_100); // 100ms

    await service.withTenantTransaction(ORG_ID, async () => 'ok');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('exactly at the 250ms threshold logs (>= boundary, not >)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_250); // exactly 250ms

    await service.withTenantTransaction(ORG_ID, async () => 'ok');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('durationMs=250'));
  });

  it('just under the threshold (249ms) does not log', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_249);

    await service.withTenantTransaction(ORG_ID, async () => 'ok');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a slow withTenantTransaction logs event/method/organizationId/durationMs via Logger.warn', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_500); // 500ms

    await service.withTenantTransaction(ORG_ID, async () => 'ok');

    expect(warnSpy).toHaveBeenCalledWith(
      `event=prisma_slow_transaction method=withTenantTransaction organizationId=${ORG_ID} durationMs=500`,
    );
  });

  it('a slow withUserTransaction logs method=withUserTransaction and userId (never organizationId)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_400); // 400ms

    await service.withUserTransaction(USER_ID, async () => 'ok');

    expect(warnSpy).toHaveBeenCalledWith(
      `event=prisma_slow_transaction method=withUserTransaction userId=${USER_ID} durationMs=400`,
    );
  });

  it('a slow withInvitationTokenTransaction logs method + durationMs only, with no unsafe correlation field', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_300); // 300ms

    await service.withInvitationTokenTransaction(TOKEN_HASH, async () => 'ok');

    expect(warnSpy).toHaveBeenCalledWith(
      'event=prisma_slow_transaction method=withInvitationTokenTransaction durationMs=300',
    );
  });

  it('a failed transaction propagates the original error unchanged and emits no slow-transaction warning, even though duration exceeded the threshold', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    const originalError = new Error('constraint violation');
    mockTransaction(service, originalError);
    mockDuration(1_000, 2_000); // 1000ms — would be "slow" if it had succeeded

    await expect(service.withTenantTransaction(ORG_ID, async () => 'ok')).rejects.toBe(originalError);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('the transaction wrapper returns the callback result unchanged', async () => {
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_050);

    const result = await service.withTenantTransaction(ORG_ID, async () => ({ id: 'abc', count: 3 }));

    expect(result).toEqual({ id: 'abc', count: 3 });
  });

  it('existing UUID validation is unchanged — an invalid organizationId still throws before any transaction starts, and logs nothing', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    const transactionSpy = jest.fn();
    (service as unknown as { $transaction: jest.Mock }).$transaction = transactionSpy;

    await expect(service.withTenantTransaction('not-a-uuid', async () => 'x')).rejects.toThrow(
      'Invalid organizationId passed to withTenantTransaction: not-a-uuid',
    );
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('security/PII — the slow-transaction log never contains SQL text, set_config calls, bound parameters, or any callback return data', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_500);

    await service.withTenantTransaction(ORG_ID, async () => ({
      secret: 'should-not-appear',
      email: 'user@test.test',
    }));

    const [message] = warnSpy.mock.calls[0];
    expect(message).not.toContain('SELECT');
    expect(message).not.toContain('set_config');
    expect(message).not.toContain('should-not-appear');
    expect(message).not.toContain('user@test.test');
    expect(message).toMatch(
      /^event=prisma_slow_transaction method=withTenantTransaction organizationId=[0-9a-f-]+ durationMs=\d+$/,
    );
  });

  it('security/PII — withInvitationTokenTransaction never logs the token hash itself', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = buildService();
    mockTransaction(service);
    mockDuration(1_000, 1_600);

    await service.withInvitationTokenTransaction(TOKEN_HASH, async () => 'ok');

    const [message] = warnSpy.mock.calls[0];
    expect(message).not.toContain(TOKEN_HASH);
  });
});
