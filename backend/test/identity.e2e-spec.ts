import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

/** Every route except /health sits behind the global prefix (main.ts / configure-app.ts). */
const API = '/api/v1';

/**
 * Phase 1 end-to-end proof: the full Workflow 1 lifecycle (org creation →
 * initial Admin verification → invite → activate → login → org
 * selection/switching → deactivate with zero-Admin protection), the
 * existing-global-User reuse path on organization creation, plus an
 * explicit RLS cross-tenant isolation proof, run against a live app
 * instance with a live PostgreSQL + Redis.
 *
 * Requires a live PostgreSQL + Redis, reachable via `DATABASE_URL`/
 * `REDIS_URL` in `.env` — natively (README.md "Local Development": local
 * PostgreSQL, Memurai for Redis) or via `docker compose up -d` at the repo
 * root, either works identically. Also requires the Phase 1 migration +
 * RLS policies applied:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run test:e2e
 *
 * Do not treat this file's existence as proof the flows work — only an
 * actual `test:e2e` run against reachable infrastructure is proof of
 * anything; see the Phase 2 verification report for current pass/fail
 * status.
 */
type SuperAgentTest = ReturnType<typeof request.agent>;

describe('Identity & Tenancy (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

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

    // A Platform Super Admin has no signup endpoint by design (Decision 1
    // — no self-service path to platform-wide access); it is seeded
    // out-of-band, exactly as it would be in a real deployment.
    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });
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

  async function createAndActivateOrg(opts: {
    legalName: string;
    adminEmail: string;
    adminPassword: string;
    superAdminAgent: SuperAgentTest;
  }) {
    const createRes = await opts.superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: opts.legalName,
        addressLine1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        primaryContactName: 'Org Admin',
        primaryContactEmail: opts.adminEmail,
        primaryContactPhone: '555-0100',
      })
      .expect(201);

    const organizationId: string = createRes.body.organization.id;
    const token = extractToken(lastEmailTo(opts.adminEmail).body);

    const activateRes = await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token, password: opts.adminPassword })
      .expect(200);

    expect(activateRes.body.organizationId).toBe(organizationId);

    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent
      .post(`${API}/auth/login`)
      .send({ email: opts.adminEmail, password: opts.adminPassword })
      .expect(200);
    expect(loginRes.body.requiresOrganizationSelection).toBe(false);

    return { organizationId, agent };
  }

  it('runs the full Workflow 1 lifecycle: org creation, verification, invite, activation, login, roles, zero-Admin protection', async () => {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    // §1.1/§1.2 — organization creation provisions a PENDING_VERIFICATION
    // Admin account; §1.3 — the initial Admin verifies and sets a password.
    const org = await createAndActivateOrg({
      legalName: 'Acme Freight LLC',
      adminEmail: 'admin@acme-freight.test',
      adminPassword: 'AcmeAdminPass123',
      superAdminAgent,
    });

    // §1.4 — Admin invites a Dispatcher.
    const inviteRes = await org.agent
      .post(`${API}/memberships/invite`)
      .send({ email: 'dispatcher@acme-freight.test', roles: ['DISPATCHER'] })
      .expect(201);
    const dispatcherMembershipId: string = inviteRes.body.id;

    // §1.5 — invitee activates via the same mechanical operation as §1.3.
    const dispatcherToken = extractToken(lastEmailTo('dispatcher@acme-freight.test').body);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: dispatcherToken, password: 'DispatcherPass123' })
      .expect(200);

    const dispatcherAgent = request.agent(app.getHttpServer());
    const dispatcherLogin = await dispatcherAgent
      .post(`${API}/auth/login`)
      .send({ email: 'dispatcher@acme-freight.test', password: 'DispatcherPass123' })
      .expect(200);
    expect(dispatcherLogin.body.requiresOrganizationSelection).toBe(false);

    // §7 Permissions Matrix — a Dispatcher cannot invite members (Admin-only).
    await dispatcherAgent
      .post(`${API}/memberships/invite`)
      .send({ email: 'someone-else@acme-freight.test', roles: ['DISPATCHER'] })
      .expect(403);

    // Admin can list both members.
    const listRes = await org.agent.get(`${API}/memberships`).expect(200);
    expect(listRes.body).toHaveLength(2);

    // §1.7 zero-Admin protection: the sole Admin cannot deactivate anyone
    // in a way that would leave the org with zero active Admins — proven
    // here as a real HTTP round trip, not just the mocked unit test.
    const adminMembership = listRes.body.find(
      (m: { user: { email: string } }) => m.user.email === 'admin@acme-freight.test',
    );
    await org.agent.post(`${API}/memberships/${adminMembership.id}/deactivate`).expect(422);

    // A non-Admin member can be deactivated freely.
    await org.agent.post(`${API}/memberships/${dispatcherMembershipId}/deactivate`).expect(200);
  });

  it('reuses an existing global User as the initial Admin of a second organization, rather than creating a duplicate identity', async () => {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const sharedEmail = 'multi-org-admin@shared-identity.test';
    const sharedPassword = 'SharedIdentityPass123';

    // First organization: brand-new identity, PENDING_VERIFICATION path.
    const orgOne = await createAndActivateOrg({
      legalName: 'First Org LLC',
      adminEmail: sharedEmail,
      adminPassword: sharedPassword,
      superAdminAgent,
    });

    // Second organization, same primaryContactEmail: must reuse the
    // existing global User (no duplicate User row) and require an
    // explicit accept (status INVITED) rather than a new password.
    const createSecondRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: 'Second Org LLC',
        addressLine1: '2 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        primaryContactName: 'Shared Admin',
        primaryContactEmail: sharedEmail,
        primaryContactPhone: '555-0200',
      })
      .expect(201);
    const orgTwoId: string = createSecondRes.body.organization.id;

    const reuseEmail = lastEmailTo(sharedEmail);
    expect(reuseEmail.subject).toContain('Admin of a new organization');

    // Activation for the reused identity requires no password — the
    // account is already verified from the first organization.
    const orgTwoToken = extractToken(reuseEmail.body);
    const activateSecondRes = await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: orgTwoToken })
      .expect(200);
    expect(activateSecondRes.body.organizationId).toBe(orgTwoId);

    // The shared identity now has two active memberships, so login must
    // land in the org-pending state rather than auto-selecting one.
    const sharedAgent = request.agent(app.getHttpServer());
    const loginRes = await sharedAgent
      .post(`${API}/auth/login`)
      .send({ email: sharedEmail, password: sharedPassword })
      .expect(200);
    expect(loginRes.body.requiresOrganizationSelection).toBe(true);
    const orgIds = loginRes.body.organizations.map((o: { id: string }) => o.id);
    expect(orgIds).toEqual(expect.arrayContaining([orgOne.organizationId, orgTwoId]));

    // §3.3 — selecting/switching both resolve to the same underlying User.
    await sharedAgent
      .post(`${API}/auth/select-organization`)
      .send({ organizationId: orgOne.organizationId })
      .expect(200);
    await sharedAgent
      .post(`${API}/auth/switch-organization`)
      .send({ organizationId: orgTwoId })
      .expect(200);
  });

  it("immediately revokes a deactivated member's existing session — Workflow 1 §1.7 (post-Phase-8 remediation, Priority 2)", async () => {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const org = await createAndActivateOrg({
      legalName: 'Revocation Test Org',
      adminEmail: 'admin@revocation-test.test',
      adminPassword: 'AdminPass123',
      superAdminAgent,
    });

    await org.agent
      .post(`${API}/memberships/invite`)
      .send({ email: 'target@revocation-test.test', roles: ['DISPATCHER'] })
      .expect(201);
    const targetToken = extractToken(lastEmailTo('target@revocation-test.test').body);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: targetToken, password: 'TargetPass123' })
      .expect(200);

    // The target's own agent — its cookie is the one that must stop working.
    const targetAgent = request.agent(app.getHttpServer());
    await targetAgent
      .post(`${API}/auth/login`)
      .send({ email: 'target@revocation-test.test', password: 'TargetPass123' })
      .expect(200);
    await targetAgent.get(`${API}/auth/me`).expect(200);

    const memberships = await org.agent.get(`${API}/memberships`).expect(200);
    const targetMembership = memberships.body.find(
      (m: { user: { email: string } }) => m.user.email === 'target@revocation-test.test',
    );
    await org.agent.post(`${API}/memberships/${targetMembership.id}/deactivate`).expect(200);

    // Same agent, same cookie, no new login — must now be rejected.
    await targetAgent.get(`${API}/auth/me`).expect(401);
  });

  it('does not revoke a session that switched to a different organization where the user remains Active (deactivation is per-membership, Priority 2)', async () => {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const sharedEmail = 'dual-org-member@revocation-scope-test.test';
    const sharedPassword = 'DualOrgPass123';

    // Org A and Org B each have their OWN distinct Admin — the shared user
    // is a plain (non-Admin) member of both, so deactivating them from Org
    // A is never blocked by zero-Admin protection (a separate, unrelated
    // rule) and actually succeeds, which is what this test needs to prove
    // anything about session scoping.
    const orgA = await createAndActivateOrg({
      legalName: 'Scoped Revocation Org A',
      adminEmail: 'admin-a@revocation-scope-test.test',
      adminPassword: 'AdminAPass123',
      superAdminAgent,
    });
    const orgB = await createAndActivateOrg({
      legalName: 'Scoped Revocation Org B',
      adminEmail: 'admin-b@revocation-scope-test.test',
      adminPassword: 'AdminBPass123',
      superAdminAgent,
    });

    await orgA.agent
      .post(`${API}/memberships/invite`)
      .send({ email: sharedEmail, roles: ['DISPATCHER'] })
      .expect(201);
    const orgAInviteToken = extractToken(lastEmailTo(sharedEmail).body);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: orgAInviteToken, password: sharedPassword })
      .expect(200);

    await orgB.agent
      .post(`${API}/memberships/invite`)
      .send({ email: sharedEmail, roles: ['DISPATCHER'] })
      .expect(201);
    // Already-verified identity — activation needs no password (mirrors
    // the "reuses an existing global User" test's second activation call).
    const orgBInviteToken = extractToken(lastEmailTo(sharedEmail).body);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: orgBInviteToken })
      .expect(200);

    const sharedAgent = request.agent(app.getHttpServer());
    const loginRes = await sharedAgent
      .post(`${API}/auth/login`)
      .send({ email: sharedEmail, password: sharedPassword })
      .expect(200);
    expect(loginRes.body.requiresOrganizationSelection).toBe(true);

    await sharedAgent
      .post(`${API}/auth/select-organization`)
      .send({ organizationId: orgA.organizationId })
      .expect(200);
    // Full context switch away from Org A (§3.3) — this session no longer belongs to Org A.
    await sharedAgent
      .post(`${API}/auth/switch-organization`)
      .send({ organizationId: orgB.organizationId })
      .expect(200);

    const orgAMemberships = await orgA.agent.get(`${API}/memberships`).expect(200);
    const sharedMembershipInOrgA = orgAMemberships.body.find(
      (m: { user: { email: string } }) => m.user.email === sharedEmail,
    );
    await orgA.agent.post(`${API}/memberships/${sharedMembershipInOrgA.id}/deactivate`).expect(200);

    // The original session, currently switched to Org B where the user
    // remains Active, must be unaffected by Org A's deactivation.
    const meAfter = await sharedAgent.get(`${API}/auth/me`).expect(200);
    expect(meAfter.body.organizationId).toBe(orgB.organizationId);
  });

  it("proves cross-tenant isolation: one organization cannot read, list, or act on another organization's membership data", async () => {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const orgA = await createAndActivateOrg({
      legalName: 'Northbound Logistics Inc',
      adminEmail: 'admin@northbound.test',
      adminPassword: 'NorthboundPass123',
      superAdminAgent,
    });
    const orgB = await createAndActivateOrg({
      legalName: 'Southline Carriers Inc',
      adminEmail: 'admin@southline.test',
      adminPassword: 'SouthlinePass123',
      superAdminAgent,
    });

    // --- Application-layer proof --------------------------------------
    // Org B's membership list must never include Org A's Admin.
    const orgBList = await orgB.agent.get(`${API}/memberships`).expect(200);
    const emails = orgBList.body.map((m: { user: { email: string } }) => m.user.email);
    expect(emails).not.toContain('admin@northbound.test');

    // Org B cannot act on Org A's membership id, even by guessing it —
    // requireMembershipTx scopes by (id AND organizationId), so a
    // cross-tenant id is indistinguishable from a nonexistent one.
    const orgAList = await orgA.agent.get(`${API}/memberships`).expect(200);
    const orgAAdminMembershipId = orgAList.body[0].id;
    await orgB.agent.post(`${API}/memberships/${orgAAdminMembershipId}/deactivate`).expect(404);

    // --- Database-layer (RLS) proof ------------------------------------
    // Bypass the service layer's own WHERE-clause scoping entirely and
    // issue a raw query for Org A's row while the Postgres session is
    // scoped to Org B (`app.current_org_id` = Org B). FORCE ROW LEVEL
    // SECURITY must reject this even though the query explicitly asks for
    // Org A's id — this is what proves RLS, not just app-layer filtering,
    // is actually engaged.
    const rowsVisibleFromWrongTenant = await prisma.withTenantTransaction(
      orgB.organizationId,
      (tx) =>
        tx.$queryRaw<
          unknown[]
        >`SELECT * FROM organization_membership WHERE organization_id = ${orgA.organizationId}::uuid`,
    );
    expect(rowsVisibleFromWrongTenant).toHaveLength(0);

    // Sanity check on the same query shape: Org A's own context DOES see
    // its own rows, proving the empty result above is RLS blocking
    // cross-tenant access — not a broken query.
    const rowsVisibleFromOwnTenant = await prisma.withTenantTransaction(
      orgA.organizationId,
      (tx) =>
        tx.$queryRaw<
          unknown[]
        >`SELECT * FROM organization_membership WHERE organization_id = ${orgA.organizationId}::uuid`,
    );
    expect(rowsVisibleFromOwnTenant.length).toBeGreaterThan(0);

    // Fail-closed proof: with NO tenant context set at all,
    // current_setting(..., true) returns NULL, and NULL = anything is
    // never true in SQL — so an unscoped session sees nothing, rather
    // than everything.
    const rowsVisibleWithNoContext = await prisma.$queryRaw<
      unknown[]
    >`SELECT * FROM organization_membership WHERE organization_id = ${orgA.organizationId}::uuid`;
    expect(rowsVisibleWithNoContext).toHaveLength(0);
  });
});
