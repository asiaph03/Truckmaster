import { Logger } from '@nestjs/common';
import { InvitationExpirationSweepService } from './invitation-expiration-sweep.service';

const ORG_ID = 'org-1';
const OTHER_ORG_ID = 'org-2';

function buildService(
  memberships: Record<string, unknown>[] = [],
  opts: { existingNotification?: Record<string, unknown> | null } = {},
) {
  const tx = {
    organizationMembership: {
      findMany: jest.fn().mockResolvedValue(memberships),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'membership-1', ...data })),
    },
    notification: {
      findFirst: jest.fn().mockResolvedValue(opts.existingNotification ?? null),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };

  const service = new InvitationExpirationSweepService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, tx, audit, prisma, notifications };
}

describe('InvitationExpirationSweepService — Workflow 1 §1.6 (proactive sweep)', () => {
  it('flips every stale INVITED membership to EXPIRED and audits it', async () => {
    const { service, tx, audit } = buildService([
      { id: 'membership-1', status: 'INVITED', invitationExpiresAt: new Date('2020-01-01') },
      { id: 'membership-2', status: 'INVITED', invitationExpiresAt: new Date('2020-01-01') },
    ]);

    await service.run();

    expect(tx.organizationMembership.update).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Invitation Expired', actorType: 'SYSTEM' }),
    );
  });

  it('does nothing when there are no stale invitations', async () => {
    const { service, tx } = buildService([]);

    await service.run();

    expect(tx.organizationMembership.update).not.toHaveBeenCalled();
  });
});

describe('InvitationExpirationSweepService — INVITATION_EXPIRED notification (Task #9)', () => {
  const MEMBERSHIP = {
    id: 'membership-1',
    status: 'INVITED',
    invitationExpiresAt: new Date('2020-01-01'),
    invitedByUserId: 'inviter-1',
  };

  it('notifies the inviter + ADMIN when an invitation expires', async () => {
    const { service, notifications } = buildService([MEMBERSHIP]);

    await service.run();

    expect(notifications.createForUserAndRoles).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      'inviter-1',
      ['ADMIN'],
      expect.objectContaining({
        type: 'INVITATION_EXPIRED',
        relatedEntityType: 'OrganizationMembership',
        relatedEntityId: 'membership-1',
      }),
    );
  });

  it('does not create a duplicate INVITATION_EXPIRED notification when one already exists', async () => {
    const { service, notifications } = buildService([MEMBERSHIP], {
      existingNotification: { id: 'existing-notif' },
    });

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });

  it('silently skips notifying when invitedByUserId is absent (no fallback broadcast)', async () => {
    const { service, notifications } = buildService([{ ...MEMBERSHIP, invitedByUserId: null }]);

    await service.run();

    expect(notifications.createForUserAndRoles).not.toHaveBeenCalled();
  });
});

describe('InvitationExpirationSweepService — Monitoring Phase 4A-2 (per-record error isolation)', () => {
  it('a failing membership does not abort the rest of that org or subsequent orgs, and logs org+entity correlation', async () => {
    const failing = { id: 'membership-fail', status: 'INVITED', invitationExpiresAt: new Date('2020-01-01') };
    const ok = { id: 'membership-ok', status: 'INVITED', invitationExpiresAt: new Date('2020-01-01') };
    const org2Record = { id: 'membership-org2', status: 'INVITED', invitationExpiresAt: new Date('2020-01-01') };

    const tx = {
      organizationMembership: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: { organizationId: string } }) =>
            Promise.resolve(where.organizationId === ORG_ID ? [failing, ok] : [org2Record]),
          ),
        update: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === 'membership-fail') throw new Error('simulated DB failure');
          return { id: where.id, status: 'EXPIRED' };
        }),
      },
      notification: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }, { id: OTHER_ORG_ID }]) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { createForUserAndRoles: jest.fn().mockResolvedValue(undefined) };
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const service = new InvitationExpirationSweepService(prisma as never, audit as never, notifications as never);

    await expect(service.run()).resolves.toBeUndefined();

    // the other membership in the SAME org still got processed
    expect(tx.organizationMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'membership-ok' } }),
    );
    // the SUBSEQUENT org still got processed
    expect(tx.organizationMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'membership-org2' } }),
    );
    // the failure was logged with org + entity correlation
    const failureLog = errorSpy.mock.calls.find((c) => String(c[0]).includes('membership-fail'));
    expect(failureLog).toBeDefined();
    expect(failureLog![0]).toContain(ORG_ID);
    expect(failureLog![0]).toContain('membership-fail');

    errorSpy.mockRestore();
  });
});
