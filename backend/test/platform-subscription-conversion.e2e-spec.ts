import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OrganizationService } from '../src/modules/identity/services/organization.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { BusinessRuleError } from '../src/common/errors/app-error';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

const API = '/api/v1';

// This suite runs against a shared, never-reset database (tms_e2e_test) —
// every generated fixture email includes this run-scoped suffix so
// repeated runs never collide with a previous run's own rows (the same
// class of pre-existing condition documented for load-lifecycle.e2e-spec.ts).
const RUN_ID = Date.now();

/**
 * Phase 4 — platform-admin subscription conversion. Two concerns need real
 * infrastructure, not a mocked-tx unit test:
 *  1. Authorization — proving PlatformSuperAdminGuard actually blocks a
 *     normal organization user (even a tenant ADMIN) at the real HTTP/guard
 *     pipeline, and actually allows a platform super admin through, for all
 *     3 new routes.
 *  2. Concurrency — proving the `FOR UPDATE` lock genuinely serializes two
 *     simultaneous conversion attempts on the same organization (a mocked
 *     tx has no real transactional semantics).
 *
 * Requires a live PostgreSQL reachable via DATABASE_URL, with migrations
 * already applied:
 *   npm run prisma:migrate:deploy
 *   npm run test:e2e
 */
describe('Platform subscription conversion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationService: OrganizationService;
  let passwordService: PasswordService;

  const superAdminEmail = `phase4-suite-super-admin-${RUN_ID}@trucktms.internal`;
  const superAdminPassword = 'SuperAdminPass123';
  let superAdminAgent: SuperAgentTest;
  let superAdminUserId: string;

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
    organizationService = app.get(OrganizationService);
    passwordService = app.get(PasswordService);

    const superAdminUser = await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Phase 4 Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });
    superAdminUserId = superAdminUser.id;

    superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Bypasses the invitation/email flow entirely — a directly-provisioned org + ACTIVE ADMIN membership is sufficient to prove PlatformSuperAdminGuard rejects a real, logged-in tenant user. */
  async function createOrgWithActiveAdmin(seed: string) {
    const email = `org-admin-${seed}-${RUN_ID}@trucktms.internal`;
    const password = 'OrgAdminPass123';
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Org Admin',
        status: 'ACTIVE',
        passwordHash: await passwordService.hash(password),
      },
    });
    const org = await prisma.organization.create({
      data: {
        legalName: `Phase 4 Auth Test Org ${seed}`,
        addressLine1: '1 Test St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Org Admin',
        primaryContactEmail: email,
        primaryContactPhone: '555-0100',
        createdByUserId: user.id,
      },
    });
    // OrganizationMembership/MembershipRole are RLS-protected — a plain
    // insert with no `app.current_org_id` set is rejected by Postgres,
    // unlike Organization/User (the two RLS-exempt tables) above.
    await prisma.withTenantTransaction(org.id, async (tx) => {
      const membership = await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: user.id, status: 'ACTIVE', activatedAt: new Date() },
      });
      await tx.membershipRole.create({
        data: { organizationId: org.id, membershipId: membership.id, role: 'ADMIN' },
      });
    });

    const agent = await withCsrf(request.agent(app.getHttpServer()));
    await agent.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return { user, org, agent };
  }

  async function createOrgWithSubscriptionState(
    seed: string,
    overrides: {
      subscriptionStatus: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
      trialStartedAt?: Date | null;
      trialEndsAt?: Date | null;
      maxCarriers?: number | null;
      maxDrivers?: number | null;
    },
  ) {
    const user = await prisma.user.create({
      data: {
        email: `phase4-org-owner-${seed}-${RUN_ID}@trucktms.internal`,
        name: 'Phase 4 Test Org Owner',
        status: 'ACTIVE',
      },
    });
    const org = await prisma.organization.create({
      data: {
        legalName: `Phase 4 Conversion Test Org ${seed} ${RUN_ID}`,
        addressLine1: '1 Test St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Test Contact',
        primaryContactEmail: `contact-${seed}-${RUN_ID}@trucktms.internal`,
        primaryContactPhone: '555-0100',
        createdByUserId: user.id,
        subscriptionStatus: overrides.subscriptionStatus,
        trialStartedAt: overrides.trialStartedAt ?? null,
        trialEndsAt: overrides.trialEndsAt ?? null,
        // `??` treats an explicit `null` override the same as "not
        // provided" and would silently fall back to the default — use
        // `in` to distinguish "caller explicitly passed null" (unlimited)
        // from "caller omitted this field" (default 1/5).
        maxCarriers: 'maxCarriers' in overrides ? overrides.maxCarriers! : 1,
        maxDrivers: 'maxDrivers' in overrides ? overrides.maxDrivers! : 5,
      },
    });
    return { user, org };
  }

  describe('Authorization', () => {
    it('platform super admin can list organizations', async () => {
      await superAdminAgent.get(`${API}/platform/organizations`).expect(200);
    });

    it('platform super admin can retrieve organization detail', async () => {
      const { org } = await createOrgWithSubscriptionState('auth-detail', {
        subscriptionStatus: 'TRIAL',
      });
      await superAdminAgent.get(`${API}/platform/organizations/${org.id}`).expect(200);
    });

    it('platform super admin can convert', async () => {
      const { org } = await createOrgWithSubscriptionState('auth-convert', {
        subscriptionStatus: 'TRIAL',
      });
      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 20 })
        .expect(200);
    });

    it('normal organization user (even a tenant ADMIN) receives a permission failure on all 3 routes', async () => {
      const { agent } = await createOrgWithActiveAdmin('auth-reject');
      const { org } = await createOrgWithSubscriptionState('auth-reject-target', {
        subscriptionStatus: 'TRIAL',
      });

      await agent.get(`${API}/platform/organizations`).expect(403);
      await agent.get(`${API}/platform/organizations/${org.id}`).expect(403);
      await agent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 5 })
        .expect(403);
    });
  });

  describe('Conversion rules', () => {
    it('TRIAL → ACTIVE succeeds', async () => {
      const { org } = await createOrgWithSubscriptionState('trial-ok', {
        subscriptionStatus: 'TRIAL',
      });

      const res = await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 20 })
        .expect(200);

      expect(res.body.subscriptionStatus).toBe('ACTIVE');
      expect(res.body.maxCarriers).toBe(5);
      expect(res.body.maxDrivers).toBe(20);
    });

    it('EXPIRED → ACTIVE succeeds', async () => {
      const { org } = await createOrgWithSubscriptionState('expired-ok', {
        subscriptionStatus: 'EXPIRED',
      });

      const res = await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: null, maxDrivers: null })
        .expect(200);

      expect(res.body.subscriptionStatus).toBe('ACTIVE');
    });

    it('ACTIVE source is rejected — no fields change', async () => {
      const { org } = await createOrgWithSubscriptionState('active-reject', {
        subscriptionStatus: 'ACTIVE',
        maxCarriers: null,
        maxDrivers: null,
      });

      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 5 })
        .expect(422);

      const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(after.maxCarriers).toBeNull();
      expect(after.maxDrivers).toBeNull();
      expect(after.subscriptionConvertedAt).toBeNull();
    });

    it('CANCELLED source is rejected — never reactivated', async () => {
      const { org } = await createOrgWithSubscriptionState('cancelled-reject', {
        subscriptionStatus: 'CANCELLED',
      });

      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 5 })
        .expect(422);

      const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(after.subscriptionStatus).toBe('CANCELLED');
    });
  });

  describe('Historical trial data', () => {
    it('preserves trialStartedAt and trialEndsAt through conversion', async () => {
      const trialStartedAt = new Date('2026-09-01T00:00:00.000Z');
      const trialEndsAt = new Date('2026-09-08T00:00:00.000Z');
      const { org } = await createOrgWithSubscriptionState('history', {
        subscriptionStatus: 'EXPIRED',
        trialStartedAt,
        trialEndsAt,
      });

      const res = await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 1, maxDrivers: 1 })
        .expect(200);

      expect(new Date(res.body.trialStartedAt).toISOString()).toBe(trialStartedAt.toISOString());
      expect(new Date(res.body.trialEndsAt).toISOString()).toBe(trialEndsAt.toISOString());
    });
  });

  describe('Limit validation', () => {
    it('rejects a negative maxCarriers with 400', async () => {
      const { org } = await createOrgWithSubscriptionState('neg', { subscriptionStatus: 'TRIAL' });
      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: -1, maxDrivers: 5 })
        .expect(400);
    });

    it('rejects a non-integer maxDrivers with 400', async () => {
      const { org } = await createOrgWithSubscriptionState('noninteger', {
        subscriptionStatus: 'TRIAL',
      });
      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 5, maxDrivers: 2.5 })
        .expect(400);
    });

    it('accepts a limit below current qualifying usage without modifying existing carriers', async () => {
      const { user, org } = await createOrgWithSubscriptionState('below-usage', {
        subscriptionStatus: 'TRIAL',
      });
      // Carrier is RLS-protected — create and later re-read it inside the
      // same tenant-context transaction helper, same reasoning as
      // createOrgWithActiveAdmin above.
      const carrier = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.carrier.create({
          data: {
            organizationId: org.id,
            legalName: 'Existing Qualifying Carrier',
            mcNumber: `MC-${org.id.slice(0, 8)}`,
            dotNumber: `DOT-${org.id.slice(0, 8)}`,
            addressLine1: '1 Carrier St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            primaryContactName: 'Dispatch',
            primaryContactPhone: '555-0200',
            primaryContactEmail: `carrier-${org.id.slice(0, 8)}@trucktms.internal`,
            status: 'ACTIVE',
            assignmentEligible: false,
            createdByUserId: user.id,
          },
        }),
      );

      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 0, maxDrivers: 0 })
        .expect(200);

      const untouchedCarrier = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.carrier.findUniqueOrThrow({ where: { id: carrier.id } }),
      );
      expect(untouchedCarrier.status).toBe('ACTIVE');
    });
  });

  describe('Audit logging', () => {
    it('creates exactly one correct audit record, and none on a rejected conversion', async () => {
      const { org } = await createOrgWithSubscriptionState('audit', { subscriptionStatus: 'TRIAL' });

      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 7, maxDrivers: 42 })
        .expect(200);

      // AuditLog is RLS-protected — read it back inside the same
      // tenant-context transaction helper, same reasoning as Carrier
      // above (a plain unscoped SELECT silently returns zero rows rather
      // than erroring, per the RLS `FORCE ROW LEVEL SECURITY` policy).
      const auditRows = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.auditLog.findMany({
          where: { organizationId: org.id, action: 'Organization Subscription Converted' },
        }),
      );
      expect(auditRows).toHaveLength(1);
      const [row] = auditRows;
      expect(row.entityType).toBe('Organization');
      expect(row.entityId).toBe(org.id);
      expect((row.newValue as Record<string, unknown>).subscriptionStatus).toBe('ACTIVE');
      expect((row.newValue as Record<string, unknown>).maxCarriers).toBe(7);
      expect((row.previousValue as Record<string, unknown>).subscriptionStatus).toBe('TRIAL');

      // Second attempt on the now-ACTIVE org is rejected — no new audit row.
      await superAdminAgent
        .patch(`${API}/platform/organizations/${org.id}/subscription`)
        .send({ maxCarriers: 1, maxDrivers: 1 })
        .expect(422);
      const auditRowsAfterRejection = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.auditLog.findMany({
          where: { organizationId: org.id, action: 'Organization Subscription Converted' },
        }),
      );
      expect(auditRowsAfterRejection).toHaveLength(1);
    });
  });

  describe('Concurrency', () => {
    it('two simultaneous conversion attempts on the same organization serialize — exactly one succeeds', async () => {
      const { org } = await createOrgWithSubscriptionState('concurrency', {
        subscriptionStatus: 'TRIAL',
      });

      // actorUserId must be a real UUID — AuditLog.actorUserId is a
      // @db.Uuid column, so a non-UUID placeholder string would fail at
      // the database level for BOTH calls (not the BusinessRuleError this
      // test is actually trying to prove), masking the real result.
      const results = await Promise.allSettled([
        organizationService.convertSubscription(
          org.id,
          { maxCarriers: 5, maxDrivers: 5 },
          superAdminUserId,
        ),
        organizationService.convertSubscription(
          org.id,
          { maxCarriers: 9, maxDrivers: 9 },
          superAdminUserId,
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BusinessRuleError);

      const finalOrg = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(finalOrg.subscriptionStatus).toBe('ACTIVE');
      // Whichever attempt won, its own limits are what stuck — not a mix of both.
      expect([5, 9]).toContain(finalOrg.maxCarriers);
    });
  });
});
