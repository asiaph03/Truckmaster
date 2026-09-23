import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OrganizationService } from '../src/modules/identity/services/organization.service';
import { ProvisioningMode } from '../src/modules/identity/dto/create-organization.dto';
import { CarrierService } from '../src/modules/carrier/services/carrier.service';
import { EntitlementService } from '../src/common/entitlement/entitlement.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { AuditService } from '../src/common/audit/audit.service';
import { BusinessRuleError } from '../src/common/errors/app-error';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

const API = '/api/v1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// This suite runs against a shared, never-reset database (tms_e2e_test) —
// every generated fixture email/legalName includes this run-scoped suffix
// so repeated runs never collide with a previous run's own rows (same
// pattern as platform-subscription-conversion.e2e-spec.ts).
const RUN_ID = Date.now();

/**
 * Phase 5 — demo/trial organization provisioning. Covers what's genuinely
 * new versus the existing Phase 1-4 suites: real-HTTP STANDARD-vs-DEMO
 * creation, real-Postgres atomicity of the (now-conditionally-branched)
 * creation transaction, immediate Phase 2 entitlement enforcement for a
 * freshly-provisioned demo org, Phase 3 expiration enforcement once a
 * demo's trial has elapsed, Phase 4's effective-status exposure on the
 * platform-admin list/detail endpoints, and TRIAL/EXPIRED -> ACTIVE
 * conversion of a demo-provisioned (not hand-inserted) organization.
 *
 * Requires a live PostgreSQL reachable via DATABASE_URL, with migrations
 * already applied:
 *   npm run prisma:migrate:deploy
 *   npm run test:e2e
 */
describe('Demo/trial organization provisioning (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let carrierService: CarrierService;
  let entitlementService: EntitlementService;
  let passwordService: PasswordService;

  const superAdminEmail = `phase5-suite-super-admin-${RUN_ID}@trucktms.internal`;
  const superAdminPassword = 'SuperAdminPass123';
  let superAdminAgent: SuperAgentTest;

  beforeAll(async () => {
    const captureEmailSender: IEmailSender = { send: async () => undefined };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(captureEmailSender)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    carrierService = app.get(CarrierService);
    entitlementService = app.get(EntitlementService);
    passwordService = app.get(PasswordService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Phase 5 Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  function createDto(seed: string, provisioningMode?: 'STANDARD' | 'DEMO') {
    return {
      legalName: `Phase 5 Org ${seed} ${RUN_ID}`,
      addressLine1: '1 Demo St',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      primaryContactName: 'Demo Contact',
      primaryContactEmail: `phase5-contact-${seed}-${RUN_ID}@trucktms.internal`,
      primaryContactPhone: '555-0100',
      ...(provisioningMode ? { provisioningMode: provisioningMode as ProvisioningMode } : {}),
    };
  }

  describe('STANDARD vs DEMO creation via HTTP', () => {
    it('provisioningMode omitted creates an ACTIVE organization with no trial and no limits, exactly as before Phase 5', async () => {
      const res = await superAdminAgent
        .post(`${API}/platform/organizations`)
        .send(createDto('standard-omitted'))
        .expect(201);

      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: res.body.organization.id },
      });
      expect(org.subscriptionStatus).toBe('ACTIVE');
      expect(org.trialStartedAt).toBeNull();
      expect(org.trialEndsAt).toBeNull();
      expect(org.maxCarriers).toBeNull();
      expect(org.maxDrivers).toBeNull();
    });

    it('provisioningMode: STANDARD behaves identically to omitting it', async () => {
      const res = await superAdminAgent
        .post(`${API}/platform/organizations`)
        .send(createDto('standard-explicit', 'STANDARD'))
        .expect(201);

      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: res.body.organization.id },
      });
      expect(org.subscriptionStatus).toBe('ACTIVE');
      expect(org.maxCarriers).toBeNull();
      expect(org.maxDrivers).toBeNull();
    });

    it('provisioningMode: DEMO creates a TRIAL organization with maxCarriers=1, maxDrivers=5, and trialEndsAt exactly 7x24h after trialStartedAt', async () => {
      const res = await superAdminAgent
        .post(`${API}/platform/organizations`)
        .send(createDto('demo-basic', 'DEMO'))
        .expect(201);

      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: res.body.organization.id },
      });
      expect(org.subscriptionStatus).toBe('TRIAL');
      expect(org.maxCarriers).toBe(1);
      expect(org.maxDrivers).toBe(5);
      expect(org.trialStartedAt).not.toBeNull();
      expect(org.trialEndsAt).not.toBeNull();
      expect(org.trialEndsAt!.getTime() - org.trialStartedAt!.getTime()).toBe(SEVEN_DAYS_MS);
    });

    it('DEMO creation still creates the initial admin User/OrganizationMembership/ADMIN role, same as STANDARD', async () => {
      const dto = createDto('demo-membership', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: dto.primaryContactEmail },
      });
      // OrganizationMembership/MembershipRole are RLS-protected.
      const membership = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.organizationMembership.findFirstOrThrow({
          where: { organizationId: orgId, userId: user.id },
          include: { roles: true },
        }),
      );
      expect(membership.status).toBe('PENDING_VERIFICATION');
      expect(membership.roles.map((r) => r.role)).toEqual(['ADMIN']);
    });
  });

  describe('Atomicity', () => {
    it('a failure partway through provisioning leaves no partial Organization/User/Membership/Role', async () => {
      const captureEmailSender: IEmailSender = { send: async () => undefined };
      let auditCallCount = 0;

      const faultyAuditModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EMAIL_SENDER)
        .useValue(captureEmailSender)
        .overrideProvider(AuditService)
        .useValue({
          // First call ("Organization Created") is allowed to no-op
          // successfully; the second call ("Initial Admin Account
          // Created"), which runs after the User/Membership/Role rows
          // already exist inside the same still-open transaction, throws —
          // proving the whole transaction (including the Organization row
          // itself) rolls back together, not just the audit write.
          record: async () => {
            auditCallCount += 1;
            if (auditCallCount === 2) {
              throw new Error('Injected atomicity-test failure');
            }
          },
        })
        .compile();

      const faultyApp = faultyAuditModule.createNestApplication();
      configureApp(faultyApp);
      await faultyApp.init();

      try {
        const faultyOrganizationService = faultyApp.get(OrganizationService);
        const dto = createDto('atomicity-fail', 'DEMO');

        await expect(
          faultyOrganizationService.createOrganization(dto, await getSuperAdminUserId()),
        ).rejects.toThrow('Injected atomicity-test failure');

        const org = await prisma.organization.findFirst({ where: { legalName: dto.legalName } });
        expect(org).toBeNull();

        const user = await prisma.user.findFirst({ where: { email: dto.primaryContactEmail } });
        expect(user).toBeNull();
      } finally {
        await faultyApp.close();
      }
    });

    async function getSuperAdminUserId(): Promise<string> {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: superAdminEmail } });
      return user.id;
    }
  });

  describe('Entitlements apply immediately to a freshly-provisioned demo organization', () => {
    it('maxCarriers=1: two simultaneous carrier creates on a new demo org result in exactly one success', async () => {
      const res = await superAdminAgent
        .post(`${API}/platform/organizations`)
        .send(createDto('demo-carrier-limit', 'DEMO'))
        .expect(201);
      const orgId = res.body.organization.id;
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: createDto('demo-carrier-limit').primaryContactEmail },
      });

      function carrierDto(suffix: string) {
        return {
          legalName: `Demo Carrier Limit ${suffix} ${RUN_ID}`,
          mcNumber: `MC-P5-${RUN_ID}-${suffix}`,
          dotNumber: `DOT-P5-${RUN_ID}-${suffix}`,
          addressLine1: '1 Carrier St',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-0200',
          primaryContactEmail: `dispatch-p5-${RUN_ID}-${suffix}@trucktms.internal`,
        };
      }

      const results = await Promise.allSettled([
        carrierService.create(orgId, carrierDto('a'), owner.id),
        carrierService.create(orgId, carrierDto('b'), owner.id),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BusinessRuleError);
    }, 30000);

    it('maxDrivers=5: six simultaneous driver adds on a new demo org result in exactly five successes', async () => {
      const dto = createDto('demo-driver-limit', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: dto.primaryContactEmail },
      });

      const carrier = await carrierService.create(
        orgId,
        {
          legalName: `Demo Driver Limit Carrier ${RUN_ID}`,
          mcNumber: `MC-P5D-${RUN_ID}`,
          dotNumber: `DOT-P5D-${RUN_ID}`,
          addressLine1: '1 Carrier St',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-0200',
          primaryContactEmail: `dispatch-p5d-${RUN_ID}@trucktms.internal`,
        },
        owner.id,
      );

      const driverDto = (suffix: string) => ({
        firstName: 'Demo',
        lastName: `Driver-${suffix}`,
        phone: `555-030${suffix}`,
      });

      const results = await Promise.allSettled(
        ['1', '2', '3', '4', '5', '6'].map((suffix) =>
          carrierService.addDriver(orgId, carrier.id, driverDto(suffix), owner.id),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BusinessRuleError);
    }, 30000);
  });

  describe('Expiration — reuses Phase 2/3 effective-status logic, no second implementation', () => {
    async function createExpiredDemoOrg(seed: string) {
      const dto = createDto(seed, 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      // Force the trial into the past — no scheduler exists (and none is
      // introduced) to do this on its own; effective status must be
      // derived live from this stored timestamp.
      await prisma.organization.update({
        where: { id: orgId },
        data: {
          trialStartedAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
          trialEndsAt: new Date(Date.now() - 60_000),
        },
      });
      return { orgId, dto };
    }

    it('Quote/Load creation (Phase 3 gate) is blocked once a demo trial has elapsed', async () => {
      const { orgId } = await createExpiredDemoOrg('demo-expired-blocked');

      await expect(
        prisma.withTenantTransaction(orgId, (tx) =>
          entitlementService.assertCanCreateOperationalRecord(tx, orgId),
        ),
      ).rejects.toThrow(BusinessRuleError);
    });

    it('allowed operations (reading existing data) remain unaffected after expiration', async () => {
      // Order matters: the carrier must be created WHILE the trial is still
      // active (expiration blocks new creation, not existing reads) — only
      // then is the org expired, and only then is the read attempted.
      const dto = createDto('demo-expired-allowed', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: dto.primaryContactEmail },
      });

      const carrier = await carrierService.create(
        orgId,
        {
          legalName: `Demo Expired Allowed Carrier ${RUN_ID}`,
          mcNumber: `MC-P5E-${RUN_ID}`,
          dotNumber: `DOT-P5E-${RUN_ID}`,
          addressLine1: '1 Carrier St',
          city: 'Dallas',
          state: 'TX',
          zip: '75201',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-0200',
          primaryContactEmail: `dispatch-p5e-${RUN_ID}@trucktms.internal`,
        },
        owner.id,
      );

      await prisma.organization.update({
        where: { id: orgId },
        data: {
          trialStartedAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
          trialEndsAt: new Date(Date.now() - 60_000),
        },
      });

      const stillReadable = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.carrier.findUniqueOrThrow({ where: { id: carrier.id } }),
      );
      expect(stillReadable.id).toBe(carrier.id);
    });
  });

  describe('Platform admin effective subscription status', () => {
    it('GET list and GET detail report EXPIRED for an elapsed demo trial, while the stored column stays TRIAL', async () => {
      const dto = createDto('demo-effective-status', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      await prisma.organization.update({
        where: { id: orgId },
        data: {
          trialStartedAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
          trialEndsAt: new Date(Date.now() - 60_000),
        },
      });

      const listRes = await superAdminAgent.get(`${API}/platform/organizations`).expect(200);
      const listRow = listRes.body.find((o: { id: string }) => o.id === orgId);
      expect(listRow.subscriptionStatus).toBe('EXPIRED');

      const detailRes = await superAdminAgent
        .get(`${API}/platform/organizations/${orgId}`)
        .expect(200);
      expect(detailRes.body.subscriptionStatus).toBe('EXPIRED');

      const stored = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(stored.subscriptionStatus).toBe('TRIAL');
    });

    it('GET list and GET detail report TRIAL for a demo org still within its 7-day window', async () => {
      const dto = createDto('demo-effective-status-active', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;

      const listRes = await superAdminAgent.get(`${API}/platform/organizations`).expect(200);
      const listRow = listRes.body.find((o: { id: string }) => o.id === orgId);
      expect(listRow.subscriptionStatus).toBe('TRIAL');

      const detailRes = await superAdminAgent
        .get(`${API}/platform/organizations/${orgId}`)
        .expect(200);
      expect(detailRes.body.subscriptionStatus).toBe('TRIAL');
    });
  });

  describe('Conversion compatibility — a demo-provisioned (not hand-inserted) organization', () => {
    it('an active-trial demo org converts TRIAL -> ACTIVE, preserving trial history', async () => {
      const dto = createDto('demo-convert-trial', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });

      const convertRes = await superAdminAgent
        .patch(`${API}/platform/organizations/${orgId}/subscription`)
        .send({ maxCarriers: 10, maxDrivers: 50 })
        .expect(200);

      expect(convertRes.body.subscriptionStatus).toBe('ACTIVE');
      expect(convertRes.body.maxCarriers).toBe(10);
      expect(convertRes.body.maxDrivers).toBe(50);
      expect(new Date(convertRes.body.trialStartedAt).toISOString()).toBe(
        before.trialStartedAt!.toISOString(),
      );
      expect(new Date(convertRes.body.trialEndsAt).toISOString()).toBe(
        before.trialEndsAt!.toISOString(),
      );
      expect(convertRes.body.subscriptionConvertedAt).not.toBeNull();
      expect(convertRes.body.subscriptionConvertedByUserId).not.toBeNull();
    });

    it('an elapsed demo trial (effective EXPIRED, stored TRIAL) still converts successfully', async () => {
      const dto = createDto('demo-convert-expired', 'DEMO');
      const res = await superAdminAgent.post(`${API}/platform/organizations`).send(dto).expect(201);
      const orgId = res.body.organization.id;
      await prisma.organization.update({
        where: { id: orgId },
        data: {
          trialStartedAt: new Date(Date.now() - SEVEN_DAYS_MS - 60_000),
          trialEndsAt: new Date(Date.now() - 60_000),
        },
      });

      const convertRes = await superAdminAgent
        .patch(`${API}/platform/organizations/${orgId}/subscription`)
        .send({ maxCarriers: null, maxDrivers: null })
        .expect(200);

      expect(convertRes.body.subscriptionStatus).toBe('ACTIVE');
    });
  });
});
