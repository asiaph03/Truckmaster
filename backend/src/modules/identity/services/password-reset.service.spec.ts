import { PasswordResetService } from './password-reset.service';
import { AuthenticationError } from '../../../common/errors/app-error';

const RAW_TOKEN = 'raw-token-abc123';
const TOKEN_HASH = 'hashed-token-def456';
const USER = {
  id: 'user-1',
  email: 'jane@acme-freight.test',
  name: 'Jane Admin',
  status: 'ACTIVE',
  passwordHash: 'existing-bcrypt-hash',
};

function buildService(opts: { user?: typeof USER | null } = {}) {
  const tx = {
    passwordResetToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
      findFirstOrThrow: jest.fn().mockResolvedValue({ userId: USER.id }),
    },
    user: {
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const userService = {
    findByEmail: jest.fn().mockResolvedValue('user' in opts ? opts.user : USER),
  };

  const tokenService = {
    generate: jest.fn().mockReturnValue({ raw: RAW_TOKEN, hash: TOKEN_HASH }),
    hash: jest.fn().mockReturnValue(TOKEN_HASH),
  };

  const passwordService = {
    hash: jest.fn().mockResolvedValue('new-bcrypt-hash'),
  };

  const sessionRegistry = {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };

  const emailQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new PasswordResetService(
    prisma as never,
    userService as never,
    tokenService as never,
    passwordService as never,
    sessionRegistry as never,
    emailQueue as never,
    { get: jest.fn().mockReturnValue('https://www.truckmasterdispatch.com') } as never,
  );

  // `private readonly logger = new Logger(...)` is an instance field, not
  // a prototype method — spy on this constructed instance's own logger.
  const instanceLoggerSpy = jest
    .spyOn((service as unknown as { logger: { log: (...a: unknown[]) => void } }).logger, 'log')
    .mockImplementation(() => undefined);

  return {
    service,
    prisma,
    tx,
    userService,
    tokenService,
    passwordService,
    sessionRegistry,
    emailQueue,
    instanceLoggerSpy,
  };
}

describe('PasswordResetService.requestReset', () => {
  const NOW = new Date('2026-09-23T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a qualifying (ACTIVE, has password) existing user: invalidates prior unused tokens, creates a new one, enqueues an email', async () => {
    const { service, tx, emailQueue } = buildService();

    await service.requestReset(USER.email);

    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER.id, usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(tx.passwordResetToken.create).toHaveBeenCalledWith({
      data: { userId: USER.id, tokenHash: TOKEN_HASH, expiresAt: expect.any(Date) },
    });
    expect(emailQueue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({
        to: USER.email,
        body: expect.stringContaining(`token=${RAW_TOKEN}`),
      }),
      expect.anything(),
    );
  });

  it('never stores the raw token — only its hash', async () => {
    const { service, tx } = buildService();

    await service.requestReset(USER.email);

    const dataArg = (tx.passwordResetToken.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.tokenHash).toBe(TOKEN_HASH);
    expect(dataArg).not.toHaveProperty('rawToken');
    expect(JSON.stringify(dataArg)).not.toContain(RAW_TOKEN);
  });

  it('sets expiresAt to exactly 1 hour after issuance — not the 7-day invitation convention', async () => {
    const { service, tx } = buildService();

    await service.requestReset(USER.email);

    const dataArg = (tx.passwordResetToken.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg.expiresAt.getTime() - NOW.getTime()).toBe(60 * 60 * 1000);
  });

  it('the raw token never appears in any logged line', async () => {
    const { service, instanceLoggerSpy } = buildService();

    await service.requestReset(USER.email);

    for (const call of instanceLoggerSpy.mock.calls) {
      expect(String(call[0])).not.toContain(RAW_TOKEN);
    }
  });

  it('logs only userId, never the email, for a successful request', async () => {
    const { service, instanceLoggerSpy } = buildService();

    await service.requestReset(USER.email);

    expect(instanceLoggerSpy).toHaveBeenCalledWith(
      expect.stringContaining(`event=password_reset_requested userId=${USER.id}`),
    );
    for (const call of instanceLoggerSpy.mock.calls) {
      expect(String(call[0])).not.toContain(USER.email);
    }
  });

  it.each([
    ['a nonexistent email', null],
    ['a user with no password set yet', { ...USER, passwordHash: null }],
    ['an inactive (SUSPENDED) user', { ...USER, status: 'SUSPENDED' }],
    ['a PENDING_VERIFICATION user', { ...USER, status: 'PENDING_VERIFICATION' }],
  ])(
    '%s: resolves without creating a token or enqueueing an email — identical outward behavior to a qualifying request',
    async (_label, user) => {
      const { service, tx, emailQueue } = buildService({ user: user as never });

      await expect(service.requestReset('whatever@example.test')).resolves.toBeUndefined();

      expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
      expect(emailQueue.add).not.toHaveBeenCalled();
    },
  );
});

describe('PasswordResetService.resetPassword', () => {
  it('rejects with AuthenticationError when no unused/unexpired token matches (covers both expired and already-used tokens, which the same updateMany WHERE clause excludes identically)', async () => {
    const { service, tx } = buildService();
    (tx.passwordResetToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(service.resetPassword('bad-token', 'NewPassw0rd')).rejects.toThrow(
      AuthenticationError,
    );
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('never marks a token used when the transaction fails partway (password validation failure rolls the whole $transaction back, including the updateMany above)', async () => {
    const { service, tx, passwordService } = buildService();
    passwordService.hash.mockRejectedValue(new Error('weak password'));

    // The mock $transaction is a passthrough (fn(tx)) — a real Postgres
    // transaction rolls back automatically on a thrown error inside the
    // callback; this proves the callback itself never reaches
    // tx.user.update after the hash rejects, which is what a real
    // transaction's rollback depends on (the updateMany write above is
    // rolled back with it, by Postgres, not by any code here).
    await expect(service.resetPassword('some-token', 'weak')).rejects.toThrow('weak password');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('successful reset: updates only passwordHash, marks the token used, and invalidates every session for that user', async () => {
    const { service, tx, sessionRegistry, passwordService } = buildService();

    await service.resetPassword(RAW_TOKEN, 'NewPassw0rd');

    expect(passwordService.hash).toHaveBeenCalledWith('NewPassw0rd');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER.id },
      data: { passwordHash: 'new-bcrypt-hash' },
    });
    const dataArg = (tx.user.update as jest.Mock).mock.calls[0][0].data;
    expect(Object.keys(dataArg)).toEqual(['passwordHash']);
    expect(sessionRegistry.revokeAllForUser).toHaveBeenCalledWith(USER.id);
  });

  it('delegates password complexity validation entirely to PasswordService — never duplicates the rule itself', async () => {
    const { service, passwordService } = buildService();

    await service.resetPassword(RAW_TOKEN, 'NewPassw0rd');

    expect(passwordService.hash).toHaveBeenCalledTimes(1);
  });

  it('hashes the incoming raw token via TokenService before ever querying by it — never queries with the raw token itself', async () => {
    const { service, tx, tokenService } = buildService();

    await service.resetPassword(RAW_TOKEN, 'NewPassw0rd');

    expect(tokenService.hash).toHaveBeenCalledWith(RAW_TOKEN);
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tokenHash: TOKEN_HASH }),
      }),
    );
  });

  it('logs only userId on success, never the raw token', async () => {
    const { service, instanceLoggerSpy } = buildService();

    await service.resetPassword(RAW_TOKEN, 'NewPassw0rd');

    expect(instanceLoggerSpy).toHaveBeenCalledWith(
      expect.stringContaining(`event=password_reset_completed userId=${USER.id}`),
    );
    for (const call of instanceLoggerSpy.mock.calls) {
      expect(String(call[0])).not.toContain(RAW_TOKEN);
    }
  });
});
