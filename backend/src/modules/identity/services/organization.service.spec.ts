import { OrganizationService } from './organization.service';
import { PermissionError } from '../../../common/errors/app-error';

/**
 * Existing-global-User reuse on Organization creation (Phase 1 report §11.1,
 * resolved: reuse the existing identity rather than blocking or duplicating
 * it). Verified here against a mocked Prisma layer, mirroring the pattern
 * already used for membership.service.spec.ts's zero-Admin protection.
 */
describe('OrganizationService.createOrganization', () => {
  const SUPER_ADMIN_ID = 'super-admin-1';
  const DTO = {
    legalName: 'Acme Freight LLC',
    addressLine1: '1 Main St',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    primaryContactName: 'Jane Admin',
    primaryContactEmail: 'jane@acme-freight.test',
    primaryContactPhone: '555-0100',
  };

  function buildService(opts: { existingUser: { id: string; email: string } | null }) {
    const createdOrganization = { id: 'org-1', legalName: DTO.legalName };
    const createdUser = { id: 'new-user-1', email: DTO.primaryContactEmail };
    const createdMembership = { id: 'membership-1' };

    const tx = {
      organization: { create: jest.fn().mockResolvedValue(createdOrganization) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      user: { create: jest.fn().mockResolvedValue(createdUser) },
      organizationMembership: { create: jest.fn().mockResolvedValue(createdMembership) },
      membershipRole: { create: jest.fn().mockResolvedValue({}) },
    };

    const prisma = {
      $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const userService = {
      findById: jest.fn().mockResolvedValue({ id: SUPER_ADMIN_ID, isPlatformSuperAdmin: true }),
      findByEmail: jest.fn().mockResolvedValue(opts.existingUser),
      create: jest.fn().mockResolvedValue(createdUser),
    };

    const tokenService = {
      generate: jest.fn().mockReturnValue({ raw: 'raw-token', hash: 'hashed-token' }),
    };

    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const emailSender = { send: jest.fn().mockResolvedValue(undefined) };

    const service = new OrganizationService(
      prisma as never,
      userService as never,
      tokenService as never,
      audit as never,
      emailSender as never,
    );

    return { service, tx, userService, audit, emailSender, createdOrganization, createdUser };
  }

  it('rejects a non-Super-Admin acting user', async () => {
    const { service, userService } = buildService({ existingUser: null });
    userService.findById.mockResolvedValue({ id: 'someone', isPlatformSuperAdmin: false });

    await expect(service.createOrganization(DTO, 'someone')).rejects.toThrow(PermissionError);
  });

  it('creates a brand-new User with PENDING_VERIFICATION membership when no identity exists for the email', async () => {
    const { service, tx, userService, emailSender } = buildService({ existingUser: null });

    await service.createOrganization(DTO, SUPER_ADMIN_ID);

    expect(userService.create).toHaveBeenCalledWith(
      { email: DTO.primaryContactEmail, name: DTO.primaryContactName },
      tx,
    );
    expect(tx.organizationMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING_VERIFICATION' }),
      }),
    );
    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('Verify your account') }),
    );
  });

  it('reuses an existing global User and creates an INVITED membership instead of a duplicate User', async () => {
    const existingUser = { id: 'existing-user-1', email: DTO.primaryContactEmail };
    const { service, tx, userService, emailSender } = buildService({ existingUser });

    await service.createOrganization(DTO, SUPER_ADMIN_ID);

    expect(userService.create).not.toHaveBeenCalled();
    expect(tx.organizationMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: existingUser.id, status: 'INVITED' }),
      }),
    );
    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('Admin of a new organization') }),
    );
  });

  it('records an "Initial Admin Assigned" audit event (not "Initial Admin Account Created") when reusing an existing identity', async () => {
    const existingUser = { id: 'existing-user-1', email: DTO.primaryContactEmail };
    const { service, audit } = buildService({ existingUser });

    await service.createOrganization(DTO, SUPER_ADMIN_ID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'Initial Admin Assigned (Existing Identity)' }),
    );
  });
});

/**
 * Frontend Phase 14 (Organization Settings) — `getCurrent`/`update`.
 * `organizationId` is always the caller-supplied value (the controller's
 * responsibility is deriving it from RequestContextStore, not this
 * service's) — these tests confirm the service itself queries/updates
 * exactly that id and nothing else, and mirrors
 * LoadService.updateReferenceNumbers's no-op-skips-audit pattern.
 */
describe('OrganizationService.getCurrent / update', () => {
  const ORG_ID = 'org-1';
  const USER_ID = 'admin-user-1';
  const EXISTING = {
    id: ORG_ID,
    legalName: 'Acme Freight LLC',
    addressLine1: '1 Main St',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    country: 'US',
    primaryContactName: 'Jane Admin',
    primaryContactEmail: 'jane@acme-freight.test',
    primaryContactPhone: '555-0100',
    defaultPaymentTerms: 'NET_30',
    status: 'ACTIVE',
    createdByUserId: 'creator-1',
    createdAt: new Date('2026-01-01'),
  };

  function buildService() {
    const tx = {
      organization: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(EXISTING),
        update: jest.fn().mockImplementation(({ data }) => ({ ...EXISTING, ...data })),
      },
    };
    const prisma = {
      organization: { findUniqueOrThrow: jest.fn().mockResolvedValue(EXISTING) },
      withTenantTransaction: jest
        .fn()
        .mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    const service = new OrganizationService(
      prisma as never,
      {} as never,
      {} as never,
      audit as never,
      {} as never,
    );

    return { service, tx, prisma, audit };
  }

  it('getCurrent looks up exactly the given organizationId', async () => {
    const { service, prisma } = buildService();

    const result = await service.getCurrent(ORG_ID);

    expect(prisma.organization.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: ORG_ID } });
    expect(result).toEqual(EXISTING);
  });

  it('update writes only the changed fields and records one audit entry listing them', async () => {
    const { service, tx, audit } = buildService();

    await service.update(ORG_ID, { legalName: 'New Name LLC', city: 'Springfield' }, USER_ID);

    expect(tx.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { legalName: 'New Name LLC', city: 'Springfield' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: ORG_ID,
        action: 'Organization Settings Updated',
        entityType: 'Organization',
        entityId: ORG_ID,
        actorUserId: USER_ID,
        previousValue: {
          field_changes: [
            { field: 'legalName', previous: EXISTING.legalName, new: 'New Name LLC' },
          ],
        },
      }),
    );
  });

  it('supports a partial update touching a single field', async () => {
    const { service, tx } = buildService();

    await service.update(ORG_ID, { defaultPaymentTerms: 'NET_60' as never }, USER_ID);

    expect(tx.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { defaultPaymentTerms: 'NET_60' },
    });
  });

  it('records no audit entry for a no-op update (submitted value equals the existing value)', async () => {
    const { service, audit } = buildService();

    await service.update(ORG_ID, { legalName: EXISTING.legalName }, USER_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('never sends id/createdByUserId/createdAt/status to the update call, even if present on the dto object', async () => {
    const { service, tx } = buildService();

    await service.update(
      ORG_ID,
      {
        legalName: 'New Name LLC',
        id: 'attacker-id',
        status: 'INACTIVE',
        createdByUserId: 'someone-else',
      } as never,
      USER_ID,
    );

    const dataArg = (tx.organization.update as jest.Mock).mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('id');
    expect(dataArg).not.toHaveProperty('status');
    expect(dataArg).not.toHaveProperty('createdByUserId');
  });
});
