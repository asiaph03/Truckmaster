import { InvitationExpirationSweepService } from './invitation-expiration-sweep.service';

const ORG_ID = 'org-1';

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
