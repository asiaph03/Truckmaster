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
    const sessionRegistry = { revokeAllForOrganization: jest.fn().mockResolvedValue(undefined) };

    const service = new MembershipService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      audit as never,
      sessionRegistry as never,
      undefined as never,
    );

    return { service, tx, audit, target, sessionRegistry };
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

  it("revokes the deactivated user's sessions for this organization once the transaction commits (Workflow 1 §1.7)", async () => {
    const { service, sessionRegistry, target } = buildService({
      targetIsAdmin: false,
      otherActiveAdminCount: 0,
    });

    await service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user');

    expect(sessionRegistry.revokeAllForOrganization).toHaveBeenCalledWith(target.userId, ORG_ID);
  });

  it('does not revoke any session when deactivation is blocked', async () => {
    const { service, sessionRegistry } = buildService({
      targetIsAdmin: true,
      otherActiveAdminCount: 0,
    });

    await expect(
      service.deactivate(ORG_ID, 'membership-target', 'acting-admin-user'),
    ).rejects.toThrow();

    expect(sessionRegistry.revokeAllForOrganization).not.toHaveBeenCalled();
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

/**
 * Frontend Phase 11 — Role editing. Mirrors deactivate()'s exact
 * zero-Admin protection test structure above (same rule, applied to
 * demotion instead of deactivation).
 */
describe('MembershipService.updateRoles — last-Admin protection', () => {
  const ORG_ID = 'org-1';

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
        findFirstOrThrow: jest.fn().mockImplementation(() => ({
          ...target,
          roles: [],
          user: { id: target.userId },
        })),
      },
      membershipRole: {
        findMany: jest.fn().mockResolvedValue(opts.targetIsAdmin ? [{ role: 'ADMIN' }] : []),
        count: jest.fn().mockResolvedValue(opts.otherActiveAdminCount),
        deleteMany: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
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
      undefined as never,
    );

    return { service, tx, audit, target };
  }

  it('blocks demoting the only active Admin to a non-Admin role set (other-demotion)', async () => {
    const { service } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });

    await expect(
      service.updateRoles(
        ORG_ID,
        'membership-target',
        { roles: ['DISPATCHER'] },
        'acting-admin-user',
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('blocks self-demotion when the acting Admin is the only active Admin', async () => {
    const { service, tx } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });
    tx.organizationMembership.findFirst.mockResolvedValue({
      id: 'membership-target',
      userId: 'acting-admin-user',
      status: 'ACTIVE',
    });

    await expect(
      service.updateRoles(
        ORG_ID,
        'membership-target',
        { roles: ['DISPATCHER'] },
        'acting-admin-user',
      ),
    ).rejects.toThrow(/only active Admin/);
  });

  it('allows demoting an Admin away from Admin when a second active Admin exists', async () => {
    const { service, tx } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 1 });

    await service.updateRoles(
      ORG_ID,
      'membership-target',
      { roles: ['DISPATCHER'] },
      'acting-admin-user',
    );

    expect(tx.membershipRole.deleteMany).toHaveBeenCalledWith({
      where: { membershipId: 'membership-target' },
    });
    expect(tx.membershipRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'DISPATCHER' }) }),
    );
  });

  it('allows promoting a non-Admin member to Admin with no restriction', async () => {
    const { service, tx } = buildService({ targetIsAdmin: false, otherActiveAdminCount: 0 });

    await service.updateRoles(
      ORG_ID,
      'membership-target',
      { roles: ['ADMIN'] },
      'acting-admin-user',
    );

    expect(tx.membershipRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN' }) }),
    );
  });

  it('does not trigger the last-Admin check when the new role set still includes Admin (not a demotion)', async () => {
    const { service, tx } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });

    await service.updateRoles(
      ORG_ID,
      'membership-target',
      { roles: ['ADMIN', 'ACCOUNTING'] },
      'acting-admin-user',
    );

    // otherActiveAdminCount was never even consulted for a blocking decision — the call succeeded.
    expect(tx.membershipRole.deleteMany).toHaveBeenCalled();
  });

  it('rejects changing roles for a membership that is not currently Active', async () => {
    const { service } = buildService({
      targetStatus: 'INVITED',
      targetIsAdmin: false,
      otherActiveAdminCount: 0,
    });

    await expect(
      service.updateRoles(
        ORG_ID,
        'membership-target',
        { roles: ['DISPATCHER'] },
        'acting-admin-user',
      ),
    ).rejects.toThrow(/Only an active member/);
  });

  it('rejects the action entirely when the acting user is not an Admin', async () => {
    const { service } = buildService({
      targetIsAdmin: false,
      otherActiveAdminCount: 1,
      actingUserRoles: ['DISPATCHER'],
    });

    await expect(
      service.updateRoles(
        ORG_ID,
        'membership-target',
        { roles: ['ACCOUNTING'] },
        'acting-non-admin-user',
      ),
    ).rejects.toThrow(/requires the ADMIN role/);
  });

  it('records an audit event with previous and new roles on a successful change', async () => {
    const { service, audit, tx } = buildService({ targetIsAdmin: false, otherActiveAdminCount: 0 });
    tx.membershipRole.findMany.mockResolvedValue([{ role: 'DISPATCHER' }]);

    await service.updateRoles(
      ORG_ID,
      'membership-target',
      { roles: ['ACCOUNTING'] },
      'acting-admin-user',
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'Member Roles Changed',
        previousValue: { roles: ['DISPATCHER'] },
        newValue: { roles: ['ACCOUNTING'] },
      }),
    );
  });

  it('records a blocked-audit event when the last-Admin demotion is rejected', async () => {
    const { service, audit } = buildService({ targetIsAdmin: true, otherActiveAdminCount: 0 });

    await expect(
      service.updateRoles(
        ORG_ID,
        'membership-target',
        { roles: ['DISPATCHER'] },
        'acting-admin-user',
      ),
    ).rejects.toThrow();

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Role Change Blocked — Last Active Admin' }),
    );
  });
});
