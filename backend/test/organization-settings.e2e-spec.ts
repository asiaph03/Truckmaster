import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

type SuperAgentTest = ReturnType<typeof request.agent>;

const API = '/api/v1';

/**
 * Frontend Phase 14 (Organization Settings) end-to-end proof:
 * `GET /organizations/current` and `PATCH /organizations/current` —
 * Admin-only access, partial updates, invalid-value rejection,
 * immutable-field rejection, and cross-tenant isolation. Run against a
 * live app instance with a live PostgreSQL + Redis.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run test:e2e
 */
describe('Organization Settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'org-settings-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let orgId: string;

  beforeAll(async () => {
    sentEmails = [];
    const captureEmailSender: IEmailSender = {
      send: async (message) => {
        sentEmails.push(message);
      },
    };

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
    const passwordService = app.get(PasswordService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Org Settings Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const org = await setUpOrganization('main');
    orgId = org.organizationId;
    adminAgent = org.adminAgent;
    dispatcherAgent = org.dispatcherAgent;
  });

  afterAll(async () => {
    await app.close();
  });

  function extractToken(body: string): string {
    const match = body.match(/token=([a-f0-9]{64})/);
    if (!match) throw new Error(`No invitation token found in email body: ${body}`);
    return match[1];
  }

  function lastEmailTo(to: string) {
    const email = [...sentEmails].reverse().find((m) => m.to === to);
    if (!email) throw new Error(`No email captured for ${to}`);
    return email;
  }

  async function activateAndLogin(email: string, password: string): Promise<SuperAgentTest> {
    const token = extractToken(lastEmailTo(email).body);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token, password })
      .expect(200);
    const agent = request.agent(app.getHttpServer());
    await agent.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return agent;
  }

  async function setUpOrganization(seed: string) {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@org-settings-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@org-settings-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Org Settings Test Org ${seed}`,
        addressLine1: '1 Main St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Org Admin',
        primaryContactEmail: adminEmail,
        primaryContactPhone: '555-0100',
      })
      .expect(201);
    const newOrgId: string = createRes.body.organization.id;

    const adminAgentLocal = await activateAndLogin(adminEmail, 'OrgAdminPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: dispatcherEmail, roles: ['DISPATCHER'] })
      .expect(201);
    const dispatcherAgentLocal = await activateAndLogin(dispatcherEmail, 'DispatcherPass123');

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
    };
  }

  describe('GET /organizations/current', () => {
    it('Admin can read the current organization', async () => {
      const res = await adminAgent.get(`${API}/organizations/current`).expect(200);
      expect(res.body.id).toBe(orgId);
      expect(res.body.legalName).toBe('Org Settings Test Org main');
      expect(res.body.defaultPaymentTerms).toBe('NET_30');
    });

    it('non-Admin is rejected', async () => {
      await dispatcherAgent.get(`${API}/organizations/current`).expect(403);
    });
  });

  describe('PATCH /organizations/current', () => {
    it('Admin can update each approved field', async () => {
      const res = await adminAgent
        .patch(`${API}/organizations/current`)
        .send({
          legalName: 'Updated Legal Name LLC',
          addressLine1: '2 New Main St',
          city: 'Fort Worth',
          state: 'TX',
          zip: '76102',
          country: 'US',
          primaryContactName: 'New Contact',
          primaryContactEmail: 'new-contact@org-settings-test.test',
          primaryContactPhone: '555-0999',
          defaultPaymentTerms: 'NET_45',
        })
        .expect(200);

      expect(res.body).toMatchObject({
        legalName: 'Updated Legal Name LLC',
        addressLine1: '2 New Main St',
        city: 'Fort Worth',
        state: 'TX',
        zip: '76102',
        country: 'US',
        primaryContactName: 'New Contact',
        primaryContactEmail: 'new-contact@org-settings-test.test',
        primaryContactPhone: '555-0999',
        defaultPaymentTerms: 'NET_45',
      });

      const confirmRes = await adminAgent.get(`${API}/organizations/current`).expect(200);
      expect(confirmRes.body.legalName).toBe('Updated Legal Name LLC');
    });

    it('a partial update changes only the submitted field, leaving every other field untouched', async () => {
      const before = await adminAgent.get(`${API}/organizations/current`).expect(200);

      const res = await adminAgent
        .patch(`${API}/organizations/current`)
        .send({ city: 'Arlington' })
        .expect(200);

      expect(res.body.city).toBe('Arlington');
      expect(res.body.legalName).toBe(before.body.legalName);
      expect(res.body.zip).toBe(before.body.zip);
      expect(res.body.defaultPaymentTerms).toBe(before.body.defaultPaymentTerms);
    });

    it('rejects an invalid defaultPaymentTerms value', async () => {
      await adminAgent
        .patch(`${API}/organizations/current`)
        .send({ defaultPaymentTerms: 'NOT_A_REAL_TERM' })
        .expect(400);
    });

    it('rejects an empty legalName', async () => {
      await adminAgent.patch(`${API}/organizations/current`).send({ legalName: '' }).expect(400);
    });

    it('rejects an invalid primaryContactEmail', async () => {
      await adminAgent
        .patch(`${API}/organizations/current`)
        .send({ primaryContactEmail: 'not-an-email' })
        .expect(400);
    });

    it('non-Admin is rejected', async () => {
      await dispatcherAgent
        .patch(`${API}/organizations/current`)
        .send({ legalName: 'Should Not Apply' })
        .expect(403);
    });

    it('rejects any attempt to set id, createdByUserId, createdAt, or status', async () => {
      const before = await adminAgent.get(`${API}/organizations/current`).expect(200);

      await adminAgent
        .patch(`${API}/organizations/current`)
        .send({ id: 'attacker-supplied-id', status: 'INACTIVE', createdByUserId: 'someone-else' })
        .expect(400);

      const after = await adminAgent.get(`${API}/organizations/current`).expect(200);
      expect(after.body.status).toBe(before.body.status);
      expect(after.body.id).toBe(before.body.id);
    });

    it('rejects a createdAt override even alongside an otherwise-valid field', async () => {
      await adminAgent
        .patch(`${API}/organizations/current`)
        .send({ legalName: 'Valid Name LLC', createdAt: '2000-01-01T00:00:00.000Z' })
        .expect(400);
    });
  });

  describe('Cross-tenant isolation', () => {
    it("one organization's Admin can never read or write another organization's settings", async () => {
      const orgB = await setUpOrganization('cross-b');

      const orgBView = await orgB.adminAgent.get(`${API}/organizations/current`).expect(200);
      expect(orgBView.body.id).toBe(orgB.organizationId);
      expect(orgBView.body.id).not.toBe(orgId);
      expect(orgBView.body.legalName).not.toBe('Updated Legal Name LLC');

      // No id/organizationId param exists on this route at all — there is
      // no way for org B's Admin to even attempt to target org A's row;
      // this proves the "current" resolution is self-contained per caller.
      await orgB.adminAgent
        .patch(`${API}/organizations/current`)
        .send({ legalName: 'Should Only Affect Org B' })
        .expect(200);

      const orgAStillUnaffected = await adminAgent.get(`${API}/organizations/current`).expect(200);
      expect(orgAStillUnaffected.body.legalName).not.toBe('Should Only Affect Org B');
    });
  });
});
