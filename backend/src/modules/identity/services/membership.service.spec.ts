import { MembershipService } from './membership.service';
import { BusinessRuleError } from '../../../common/errors/app-error';

/**
 * Zero-Admin protection (Workflow 1 §1.7) is the single most safety-
 * critical rule in Phase 1 — tested here against a mocked Prisma layer
 * so the branching logic is verified without needing a live database.
 * Full end-to-end proof (including the transactional re-count race-
 * condition guard, §4.5) lives in test/identity.e2e-spec.ts, which
 * requires live Postgres and is not run in this sandbox — see the
 * Phase 1 report.
 */
describe('MembershipService.deactivate — zero-Admin protection', () => {
  const ORG_ID = 'org-1';
  const ADMIN_ROLE_ROW = { role: 'ADMIN' };

  function buildService(opts: {
    targetStatus?: string;
    targetIsAdmin: boolean;
    otherActiveAdminCount: number;
    actingUserRoles?: string[];
  }) {
    const target = {
      id: 'membership-target',
      userId: 'user-target',
      status: opts.targetStatus ?? 'ACTIVE',
    };

    const tx = {
      organizationMembership: {
        findFirst: jest.fn().mockResolvedValue(target),
        findMany: jest.fn(), // getRoles uses findFirst+include, not used here
        update: jest.fn().mockImplementation(({ data }) => ({ ...target, ...data })),
      },
      membershipRole: {
        findMany: jest.fn().mockResolvedValue(opts.targetIsAdmin ? [ADMIN_ROLE_ROW] : []),
        count: jest.fn().mockResolvedValue(opts.otherActiveAdminCount),
      },
    };

    const userTx = {
      organizationMembership: {
        findFirst: jest.fn().mockResolvedValue({
          roles: (opts.actingUserRoles ?? ['ADMIN']).map((role) => ({ role })),
        }),
      },
    };

    const prisma = {
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
      // getRoles() (used by assertHasRole, called for both the acting user's
      // permission check and the zero-Admin recount) now runs inside
      // withUserTransaction rather than a bare prisma call — see
      // membership.service.ts and the identity-bootstrap RLS note in
      // prisma/rls/0001_identity_rls.sql.
      withUserTransaction: jest
        .fn()
        .mockImplementation((_userId: string, fn: (tx: unknown) => unknown) => fn(userTx)),
    };

    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    const service = new MembershipService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      audit as never,
      undefined as never,
    );

    return { service, tx, audit, target };
  }

  it('blocks deactivating the only active Admin (other-deactivation)', async () => {
    const { service } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user'),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('blocks self-deactivation when the acting Admin is the only active Admin', async () => {
    const { service, tx } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });
    // Self-deactivation: target.userId === actingUserId
    tx.organizationMembership.findFirst.mockResolvedValue({
      id: 'membership-target',
      userId: 'acting-admin-user',
      status: 'ACTIVE',
    });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user'),
    ).rejects.toThrow(/only active Admin/);
  });

  it('allows deactivating an Admin when a second active Admin exists', async () => {
    const { service, tx } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 1 });

    await service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user');

    expect(tx.organizationMembership.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'INACTIVE' }) }),
    );
  });

  it('allows deactivating a non-Admin member regardless of Admin count', async () => {
    const { service, tx } = buildService({ targetIsAdmin: false, otherActiveAdminCount: 0 });

    await service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user');

    expect(tx.organizationMembership.update).toHaveBeenCalled();
  });

  it('records an audit event when deactivation is blocked, for traceability', async () => {
    const { service, audit } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user'),
    ).rejects.toThrow();

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'User Deactivation Blocked — Last Active Admin' }),
    );
  });

  it('rejects deactivating a membership that is not currently Active', async () => {
    const { service } = buildService({
      targetStatus: 'INACTIVE',
      targetIsAdmin: false,
      otherActiveAdminCount: 0,
    });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user'),
    ).rejects.toThrow(/Only an active member/);
  });

  it('rejects the action entirely when the acting user is not an Admin', async () => {
    const { service } = buildService({
      targetIsAdmin: false,
      otherActiveAdminCount: 1,
      actingUserRoles: ['DISPATCHER'],
    });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-non-admin-user'),
    ).rejects.toThrow(/requires the ADMIN role/);
  });
});
