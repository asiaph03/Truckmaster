import { SessionRegistryService, SESSION_REDIS_KEY_PREFIX } from './session-registry.service';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';
const SESSION_ID = 'sess-abc';

function buildService(sessionIdsInIndex: string[] = []) {
  const redis = {
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue(sessionIdsInIndex),
    del: jest.fn().mockResolvedValue(1),
  };

  const service = new SessionRegistryService(redis as never);
  return { service, redis };
}

describe('SessionRegistryService.recordActiveOrganization', () => {
  it('adds the session id to the (user, org) index set and refreshes its TTL', async () => {
    const { service, redis } = buildService();

    await service.recordActiveOrganization(SESSION_ID, USER_ID, ORG_ID);

    expect(redis.sadd).toHaveBeenCalledWith(`tms:sess-index:${USER_ID}:${ORG_ID}`, SESSION_ID);
    expect(redis.expire).toHaveBeenCalledWith(
      `tms:sess-index:${USER_ID}:${ORG_ID}`,
      60 * 60 * 24 * 7,
    );
  });

  it('removes the session from the previous org set on a full context switch (§3.3)', async () => {
    const { service, redis } = buildService();

    await service.recordActiveOrganization(SESSION_ID, USER_ID, ORG_ID, OTHER_ORG_ID);

    expect(redis.srem).toHaveBeenCalledWith(
      `tms:sess-index:${USER_ID}:${OTHER_ORG_ID}`,
      SESSION_ID,
    );
    expect(redis.sadd).toHaveBeenCalledWith(`tms:sess-index:${USER_ID}:${ORG_ID}`, SESSION_ID);
  });

  it('does not touch the previous org set when it is the same org', async () => {
    const { service, redis } = buildService();

    await service.recordActiveOrganization(SESSION_ID, USER_ID, ORG_ID, ORG_ID);

    expect(redis.srem).not.toHaveBeenCalled();
  });
});

describe('SessionRegistryService.forget', () => {
  it('removes the session id from its org index set', async () => {
    const { service, redis } = buildService();

    await service.forget(SESSION_ID, USER_ID, ORG_ID);

    expect(redis.srem).toHaveBeenCalledWith(`tms:sess-index:${USER_ID}:${ORG_ID}`, SESSION_ID);
  });
});

describe('SessionRegistryService.revokeAllForOrganization — Workflow 1 §1.7', () => {
  it('deletes every indexed session key and clears the index', async () => {
    const { service, redis } = buildService(['sess-1', 'sess-2']);

    await service.revokeAllForOrganization(USER_ID, ORG_ID);

    expect(redis.del).toHaveBeenCalledWith(`${SESSION_REDIS_KEY_PREFIX}sess-1`);
    expect(redis.del).toHaveBeenCalledWith(`${SESSION_REDIS_KEY_PREFIX}sess-2`);
    expect(redis.del).toHaveBeenCalledWith(`tms:sess-index:${USER_ID}:${ORG_ID}`);
  });

  it('is a no-op when the user has no session currently selected to this org', async () => {
    const { service, redis } = buildService([]);

    await service.revokeAllForOrganization(USER_ID, ORG_ID);

    expect(redis.del).not.toHaveBeenCalled();
  });
});
