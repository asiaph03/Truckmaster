import { InvitationExpirationSweepService } from './invitation-expiration-sweep.service';

const ORG_ID = 'org-1';

function buildService(memberships: Record<string, unknown>[] = []) {
  const tx = {
    organizationMembership: {
      findMany: jest.fn().mockResolvedValue(memberships),
      update: jest.fn().mockImplementation(({ data }) => ({ id: 'membership-1', ...data })),
    },
  };

  const prisma = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: ORG_ID }]) },
    withTenantTransaction: jest
      .fn()
      .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new InvitationExpirationSweepService(prisma as never, audit as never);
  return { service, tx, audit, prisma };
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
