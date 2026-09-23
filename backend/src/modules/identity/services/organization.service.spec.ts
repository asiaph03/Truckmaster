import { OrganizationService } from './organization.service';
import { BusinessRuleError, NotFoundError, PermissionError } from '../../../common/errors/app-error';

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
    const emailQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const service = new OrganizationService(
      prisma as never,
      userService as never,
      tokenService as never,
      audit as never,
      emailQueue as never,
      { get: jest.fn().mockReturnValue('https://www.truckmasterdispatch.com') } as never,
    );

    return { service, tx, userService, audit, emailQueue, createdOrganization, createdUser };
  }

  it('rejects a non-Super-Admin acting user', async () => {
    const { service, userService } = buildService({ existingUser: null });
    userService.findById.mockResolvedValue({ id: 'someone', isPlatformSuperAdmin: false });

    await expect(service.createOrganization(DTO, 'someone')).rejects.toThrow(PermissionError);
  });

  it('creates a brand-new User with PENDING_VERIFICATION membership when no identity exists for the email', async () => {
    const { service, tx, userService, emailQueue } = buildService({ existingUser: null });

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
    expect(emailQueue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ subject: expect.stringContaining('Verify your account') }),
      expect.anything(),
    );
  });

  it('reuses an existing global User and creates an INVITED membership instead of a duplicate User', async () => {
    const existingUser = { id: 'existing-user-1', email: DTO.primaryContactEmail };
    const { service, tx, userService, emailQueue } = buildService({ existingUser });

    await service.createOrganization(DTO, SUPER_ADMIN_ID);

    expect(userService.create).not.toHaveBeenCalled();
    expect(tx.organizationMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: existingUser.id, status: 'INVITED' }),
      }),
    );
    expect(emailQueue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ subject: expect.stringContaining('Admin of a new organization') }),
      expect.anything(),
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

  /**
   * Monitoring — subscription fields (Phase 1, data model only). A normal
   * (non-demo) organization creation must keep relying on the schema-level
   * defaults (`subscriptionStatus: ACTIVE`, `maxCarriers`/`maxDrivers:
   * null` — unlimited) exactly like `defaultPaymentTerms` already does,
   * rather than this call site ever setting them explicitly. No `isDemo`
   * field/boolean exists or is introduced — `subscriptionStatus: TRIAL` is
   * itself the future discriminator for a demo organization, set by a
   * later, separate creation path, not here.
   */
  it('never sets subscription/entitlement fields — relies entirely on the schema-level ACTIVE/unlimited defaults', async () => {
    const { service, tx } = buildService({ existingUser: null });

    await service.createOrganization(DTO, SUPER_ADMIN_ID);

    const dataArg = (tx.organization.create as jest.Mock).mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('subscriptionStatus');
    expect(dataArg).not.toHaveProperty('trialStartedAt');
    expect(dataArg).not.toHaveProperty('trialEndsAt');
    expect(dataArg).not.toHaveProperty('maxCarriers');
    expect(dataArg).not.toHaveProperty('maxDrivers');
    expect(dataArg).not.toHaveProperty('subscriptionConvertedAt');
    expect(dataArg).not.toHaveProperty('subscriptionConvertedByUserId');
    expect(dataArg).not.toHaveProperty('isDemo');
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

/**
 * Phase 4 — platform-admin subscription conversion
 * (findAllForPlatformAdmin / findByIdForPlatformAdmin / convertSubscription).
 * No organization session exists for these calls (PlatformSuperAdminGuard
 * never populates RequestContextStore.organizationId) — organizationId is
 * always an explicit parameter, never derived from context.
 */
describe('OrganizationService — Phase 4 platform-admin subscription conversion', () => {
  const ORG_ID = 'org-1';
  const ADMIN_ID = 'platform-admin-1';

  function makeOrg(overrides: Record<string, unknown> = {}) {
    return {
      id: ORG_ID,
      legalName: 'Acme Freight LLC',
      primaryContactName: 'Jane Admin',
      primaryContactEmail: 'jane@acme-freight.test',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01'),
      subscriptionStatus: 'TRIAL',
      trialStartedAt: new Date('2026-09-01T00:00:00.000Z'),
      trialEndsAt: new Date('2026-09-08T00:00:00.000Z'),
      maxCarriers: 1,
      maxDrivers: 5,
      subscriptionConvertedAt: null,
      subscriptionConvertedByUserId: null,
      ...overrides,
    };
  }

  function buildService(opts: {
    org?: ReturnType<typeof makeOrg> | null;
    carrierCount?: number;
    driverCount?: number;
  } = {}) {
    const org = 'org' in opts ? opts.org : makeOrg();

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      organization: {
        findUnique: jest.fn().mockResolvedValue(org),
        update: jest.fn().mockImplementation(({ data }) => ({ ...org, ...data })),
      },
    };

    const prisma = {
      organization: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(org),
      },
      carrier: { count: jest.fn().mockResolvedValue(opts.carrierCount ?? 0) },
      driver: { count: jest.fn().mockResolvedValue(opts.driverCount ?? 0) },
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
      {} as never,
    );

    return { service, tx, prisma, audit, org };
  }

  describe('findAllForPlatformAdmin', () => {
    it('returns only the summary fields, no address/contact/payment-terms data', async () => {
      const { service, prisma } = buildService();

      await service.findAllForPlatformAdmin();

      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            legalName: true,
            subscriptionStatus: true,
            trialStartedAt: true,
            trialEndsAt: true,
            maxCarriers: true,
            maxDrivers: true,
          },
        }),
      );
    });
  });

  describe('findByIdForPlatformAdmin', () => {
    it('includes the current qualifying carrier/driver counts, using the exact Phase 2 qualifying definitions', async () => {
      const { service, prisma } = buildService({ carrierCount: 1, driverCount: 4 });

      const result = await service.findByIdForPlatformAdmin(ORG_ID);

      expect(prisma.carrier.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, status: { in: ['PENDING', 'ACTIVE'] } },
      });
      expect(prisma.driver.count).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, active: true },
      });
      expect(result?.qualifyingCarrierCount).toBe(1);
      expect(result?.qualifyingDriverCount).toBe(4);
    });

    it('returns null for a nonexistent organization, without counting anything', async () => {
      const { service, prisma } = buildService({ org: null });

      const result = await service.findByIdForPlatformAdmin('nonexistent');

      expect(result).toBeNull();
      expect(prisma.carrier.count).not.toHaveBeenCalled();
      expect(prisma.driver.count).not.toHaveBeenCalled();
    });
  });

  describe('convertSubscription', () => {
    it('locks the Organization row (FOR UPDATE) before reading/updating it', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'TRIAL' }) });

      await service.convertSubscription(ORG_ID, { maxCarriers: 5, maxDrivers: 20 }, ADMIN_ID);

      expect(tx.$queryRaw).toHaveBeenCalled();
      const callOrder = (tx.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
      const updateOrder = (tx.organization.update as jest.Mock).mock.invocationCallOrder[0];
      expect(callOrder).toBeLessThan(updateOrder);
    });

    it('converts a TRIAL organization to ACTIVE with the requested limits', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'TRIAL' }) });

      const result = await service.convertSubscription(
        ORG_ID,
        { maxCarriers: 5, maxDrivers: 20 },
        ADMIN_ID,
      );

      expect(tx.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: expect.objectContaining({
          subscriptionStatus: 'ACTIVE',
          maxCarriers: 5,
          maxDrivers: 20,
          subscriptionConvertedAt: expect.any(Date),
          subscriptionConvertedByUserId: ADMIN_ID,
        }),
      });
      expect(result.subscriptionStatus).toBe('ACTIVE');
    });

    it('converts an EXPIRED organization to ACTIVE with the requested limits', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'EXPIRED' }) });

      await service.convertSubscription(ORG_ID, { maxCarriers: null, maxDrivers: null }, ADMIN_ID);

      expect(tx.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: expect.objectContaining({ subscriptionStatus: 'ACTIVE' }),
      });
    });

    it('rejects conversion of an already-ACTIVE organization — no update, no audit', async () => {
      const { service, tx, audit } = buildService({ org: makeOrg({ subscriptionStatus: 'ACTIVE' }) });

      await expect(
        service.convertSubscription(ORG_ID, { maxCarriers: 5, maxDrivers: 20 }, ADMIN_ID),
      ).rejects.toThrow(BusinessRuleError);
      expect(tx.organization.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects conversion of a CANCELLED organization — no update, no audit, never reactivates', async () => {
      const { service, tx, audit } = buildService({
        org: makeOrg({ subscriptionStatus: 'CANCELLED' }),
      });

      await expect(
        service.convertSubscription(ORG_ID, { maxCarriers: 5, maxDrivers: 20 }, ADMIN_ID),
      ).rejects.toThrow(BusinessRuleError);
      expect(tx.organization.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundError for a nonexistent organization', async () => {
      const { service } = buildService({ org: null });

      await expect(
        service.convertSubscription('nonexistent', { maxCarriers: 1, maxDrivers: 1 }, ADMIN_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('preserves trialStartedAt and trialEndsAt — never clears or modifies them', async () => {
      const trialStartedAt = new Date('2026-09-01T00:00:00.000Z');
      const trialEndsAt = new Date('2026-09-08T00:00:00.000Z');
      const { service, tx } = buildService({
        org: makeOrg({ subscriptionStatus: 'EXPIRED', trialStartedAt, trialEndsAt }),
      });

      await service.convertSubscription(ORG_ID, { maxCarriers: 5, maxDrivers: 20 }, ADMIN_ID);

      const dataArg = (tx.organization.update as jest.Mock).mock.calls[0][0].data;
      expect(dataArg).not.toHaveProperty('trialStartedAt');
      expect(dataArg).not.toHaveProperty('trialEndsAt');
    });

    it('accepts 0 as a valid limit — blocks all new qualifying resources, not a separate status', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'TRIAL' }) });

      await service.convertSubscription(ORG_ID, { maxCarriers: 0, maxDrivers: 0 }, ADMIN_ID);

      expect(tx.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: expect.objectContaining({ maxCarriers: 0, maxDrivers: 0 }),
      });
    });

    it('allows a limit below current qualifying usage — never touches existing carriers/drivers', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'TRIAL' }) });

      await service.convertSubscription(ORG_ID, { maxCarriers: 5, maxDrivers: 3 }, ADMIN_ID);

      expect(tx.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: expect.objectContaining({ maxCarriers: 5, maxDrivers: 3 }),
      });
      // Only the Organization row is ever touched — this tx mock has no
      // carrier/driver mutation methods defined at all, so any attempt to
      // modify existing resources would throw, not silently pass.
      expect(Object.keys(tx)).toEqual(['$queryRaw', 'organization']);
    });

    it('does not accept subscriptionStatus from the caller — always converts to ACTIVE regardless', async () => {
      const { service, tx } = buildService({ org: makeOrg({ subscriptionStatus: 'TRIAL' }) });

      await service.convertSubscription(
        ORG_ID,
        { maxCarriers: 5, maxDrivers: 20, subscriptionStatus: 'CANCELLED' } as never,
        ADMIN_ID,
      );

      expect(tx.organization.update).toHaveBeenCalledWith({
        where: { id: ORG_ID },
        data: expect.objectContaining({ subscriptionStatus: 'ACTIVE' }),
      });
    });

    it('creates exactly one audit record with the correct actor, organization, and before/after subscription state', async () => {
      const { service, tx, audit } = buildService({
        org: makeOrg({
          subscriptionStatus: 'TRIAL',
          maxCarriers: 1,
          maxDrivers: 5,
        }),
      });

      await service.convertSubscription(ORG_ID, { maxCarriers: 10, maxDrivers: 50 }, ADMIN_ID);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          organizationId: ORG_ID,
          action: 'Organization Subscription Converted',
          entityType: 'Organization',
          entityId: ORG_ID,
          actorUserId: ADMIN_ID,
          previousValue: expect.objectContaining({
            subscriptionStatus: 'TRIAL',
            maxCarriers: 1,
            maxDrivers: 5,
          }),
          newValue: expect.objectContaining({
            subscriptionStatus: 'ACTIVE',
            maxCarriers: 10,
            maxDrivers: 50,
          }),
        }),
      );
    });
  });
});
