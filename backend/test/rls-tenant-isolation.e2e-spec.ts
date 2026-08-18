import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

const API = '/api/v1';

/**
 * Regression proof for the NULLIF RLS fix (prisma/rls/0001_identity_rls.sql,
 * 0002_core_master_data_rls.sql) and the identity-bootstrap RLS exceptions
 * (app.current_user_id / app.current_invitation_token_hash) added alongside
 * it — see PrismaService.withUserTransaction /
 * withInvitationTokenTransaction and the "Identity-bootstrap exceptions"
 * note in 0001_identity_rls.sql for the full rationale.
 *
 * Requires a live PostgreSQL reachable via DATABASE_URL, with migrations
 * and RLS policies already applied:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run test:e2e
 *
 * Tests 1–7 and 10–12 use a dedicated single-connection PrismaClient
 * (`connection_limit=1`) so the pooled-connection-reuse behavior being
 * proven is deterministic rather than incidental to whichever physical
 * connection Prisma's normal pool happens to hand back. Do not treat this
 * file's existence as proof — only an actual run against reachable
 * infrastructure verifies anything.
 */
type SuperAgentTest = ReturnType<typeof request.agent>;

function soloConnectionUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set — required to run this spec.');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}connection_limit=1&pool_timeout=0`;
}

/** Mirrors PrismaService.withTenantTransaction, for the solo test client. */
async function withOrgContext<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  return client.$transaction((tx) =>
    tx.$executeRaw`SELECT set_config('app.current_org_id', ${organizationId}, true)`.then(() =>
      fn(tx as never),
    ),
  );
}

/** Mirrors PrismaService.withUserTransaction, for the solo test client. */
async function withUserContext<T>(
  client: PrismaClient,
  userId: string,
  fn: (tx: Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  return client.$transaction((tx) =>
    tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`.then(() =>
      fn(tx as never),
    ),
  );
}

describe('RLS tenant-isolation regression suite (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'rls-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'RlsSuiteSuperAdminPass123';

  // Populated in beforeAll: two real, activated organizations + admins,
  // used as fixture data by every test below.
  let orgA: { organizationId: string; adminUserId: string; agent: SuperAgentTest };
  let orgB: { organizationId: string; adminUserId: string; agent: SuperAgentTest };

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
        name: 'RLS Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    orgA = await createAndActivateOrg({
      legalName: 'RLS Suite Org A LLC',
      adminEmail: 'admin-a@rls-suite.test',
      adminPassword: 'OrgAAdminPass123',
      superAdminAgent,
    });
    orgB = await createAndActivateOrg({
      legalName: 'RLS Suite Org B LLC',
      adminEmail: 'admin-b@rls-suite.test',
      adminPassword: 'OrgBAdminPass123',
      superAdminAgent,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function lastEmailTo(to: string) {
    const email = [...sentEmails].reverse().find((m) => m.to === to);
    if (!email) throw new Error(`No email captured for ${to}`);
    return email;
  }

  function extractToken(body: string): string {
    const match = body.match(/token=([a-f0-9]{64})/);
    if (!match) throw new Error(`No invitation token found in email body: ${body}`);
    return match[1];
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

    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token, password: opts.adminPassword })
      .expect(200);

    // activate()'s response carries no userId (only membershipId/
    // organizationId) — "user" is a global, un-RLS'd table (no
    // organization_id column), so this direct lookup is unaffected by any
    // of the RLS behavior under test.
    const adminUser = await prisma.user.findUnique({ where: { email: opts.adminEmail } });
    if (!adminUser) throw new Error(`Activated user not found for ${opts.adminEmail}`);
    const adminUserId = adminUser.id;

    const agent = request.agent(app.getHttpServer());
    const loginRes = await agent
      .post(`${API}/auth/login`)
      .send({ email: opts.adminEmail, password: opts.adminPassword })
      .expect(200);
    expect(loginRes.body.requiresOrganizationSelection).toBe(false);

    return { organizationId, adminUserId, agent };
  }

  // -----------------------------------------------------------------------
  // 1–7: pooled-connection-reuse regression, via a dedicated single-
  // connection client so "the same physical connection" is guaranteed
  // rather than incidental.
  // -----------------------------------------------------------------------

  it('1. a virgin connection with no tenant context ever set sees no rows', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      const rows = await solo.$queryRaw`SELECT * FROM organization_membership`;
      expect(rows).toHaveLength(0);
    } finally {
      await solo.$disconnect();
    }
  });

  it('2. after a tenant transaction commits, a bare query on the same connection fails closed instead of crashing on invalid uuid', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      // Establish real tenant context and confirm it works, exactly like
      // production code via withTenantTransaction.
      const rowsDuringTransaction = await withOrgContext(
        solo,
        orgA.organizationId,
        (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM organization_membership`,
      );
      expect(rowsDuringTransaction.length).toBeGreaterThan(0);

      // Postgres reverts the placeholder app.current_org_id GUC to '' after
      // the transaction ends (empirically confirmed, documented in
      // 0001_identity_rls.sql) — a bare query on this same connection must
      // not throw `invalid input syntax for type uuid: ""`.
      await expect(solo.$queryRaw`SELECT * FROM organization_membership`).resolves.toBeDefined();
    } finally {
      await solo.$disconnect();
    }
  });

  it("3. a valid tenant context returns exactly that tenant's rows", async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      const rows = await withOrgContext(
        solo,
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            { organization_id: string }[]
          >`SELECT organization_id FROM organization_membership WHERE organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.organization_id === orgA.organizationId)).toBe(true);
    } finally {
      await solo.$disconnect();
    }
  });

  it("4. tenant A cannot read tenant B's rows even when explicitly querying for B's organization_id", async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      const rowsAQueryingForB = await withOrgContext(
        solo,
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM organization_membership WHERE organization_id = ${orgB.organizationId}::uuid`,
      );
      expect(rowsAQueryingForB).toHaveLength(0);
    } finally {
      await solo.$disconnect();
    }
  });

  it('5. a connection reused across a full commit → bare-query cycle does not crash', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      await withOrgContext(solo, orgA.organizationId, (tx) => tx.$queryRaw`SELECT 1`);
      await expect(solo.$queryRaw`SELECT * FROM organization_membership`).resolves.toBeDefined();
      await withOrgContext(solo, orgB.organizationId, (tx) => tx.$queryRaw`SELECT 1`);
      await expect(solo.$queryRaw`SELECT * FROM organization_membership`).resolves.toBeDefined();
    } finally {
      await solo.$disconnect();
    }
  });

  it('6. the bare query after a committed tenant transaction fails closed (zero rows), not just "doesn\'t crash"', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      await withOrgContext(solo, orgA.organizationId, (tx) => tx.$queryRaw`SELECT 1`);
      const rows = await solo.$queryRaw<unknown[]>`SELECT * FROM organization_membership`;
      expect(rows).toHaveLength(0);
    } finally {
      await solo.$disconnect();
    }
  });

  it("7. repeated pooled requests on the same connection can never inherit a previous request's tenant context", async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      // Org A's transaction, on the connection, sees only Org A.
      const aRows = await withOrgContext(
        solo,
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            { organization_id: string }[]
          >`SELECT organization_id FROM organization_membership`,
      );
      expect(aRows.every((r) => r.organization_id === orgA.organizationId)).toBe(true);

      // Immediately after, on the SAME physical connection, Org B's
      // transaction must see only Org B — no bleed-through from A's
      // just-ended transaction.
      const bRows = await withOrgContext(
        solo,
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            { organization_id: string }[]
          >`SELECT organization_id FROM organization_membership`,
      );
      expect(bRows.every((r) => r.organization_id === orgB.organizationId)).toBe(true);
      expect(bRows.some((r) => r.organization_id === orgA.organizationId)).toBe(false);

      // And back to A a third time, ruling out any cumulative/one-shot-only
      // effect from the earlier transactions.
      const aRowsAgain = await withOrgContext(
        solo,
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            { organization_id: string }[]
          >`SELECT organization_id FROM organization_membership`,
      );
      expect(aRowsAgain.every((r) => r.organization_id === orgA.organizationId)).toBe(true);
    } finally {
      await solo.$disconnect();
    }
  });

  // -----------------------------------------------------------------------
  // 8: login/org-selection flow, exercised end-to-end through the real app
  // — this is what actually proves getRoles / listActiveMemberships /
  // resolveOrganizationSession work under genuinely-active RLS (relies on
  // beforeAll's DB-level fixture setup all having gone through real HTTP
  // routes, not direct Prisma writes).
  // -----------------------------------------------------------------------

  it('8. login succeeds and returns correct roles/org after activation, for both a single-org and a multi-org identity', async () => {
    // Single-org case: orgA's admin, already logged in during beforeAll —
    // prove it again explicitly here with a fresh agent/session.
    const freshAgent = request.agent(app.getHttpServer());
    const loginRes = await freshAgent
      .post(`${API}/auth/login`)
      .send({ email: 'admin-a@rls-suite.test', password: 'OrgAAdminPass123' })
      .expect(200);
    expect(loginRes.body.requiresOrganizationSelection).toBe(false);

    // login()'s own response carries no session data (it's stored
    // server-side only) — GET /auth/me reads it back, proving getRoles()
    // actually populated req.session.auth.roles under real RLS.
    const meRes = await freshAgent.get(`${API}/auth/me`).expect(200);
    expect(meRes.body.organizationId).toBe(orgA.organizationId);
    expect(meRes.body.roles).toContain('ADMIN');

    // Multi-org case: a shared identity invited into both orgs must reach
    // the org-pending state (listActiveMemberships genuinely cross-org),
    // then resolve correctly via select-organization (resolveOrganizationSession).
    const sharedEmail = 'multi-org@rls-suite.test';
    const sharedPassword = 'MultiOrgPass123';

    await orgA.agent
      .post(`${API}/memberships/invite`)
      .send({ email: sharedEmail, roles: ['DISPATCHER'] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: extractToken(lastEmailTo(sharedEmail).body), password: sharedPassword })
      .expect(200);

    await orgB.agent
      .post(`${API}/memberships/invite`)
      .send({ email: sharedEmail, roles: ['DISPATCHER'] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${API}/auth/activate`)
      .send({ token: extractToken(lastEmailTo(sharedEmail).body) })
      .expect(200);

    const sharedAgent = request.agent(app.getHttpServer());
    const sharedLoginRes = await sharedAgent
      .post(`${API}/auth/login`)
      .send({ email: sharedEmail, password: sharedPassword })
      .expect(200);
    expect(sharedLoginRes.body.requiresOrganizationSelection).toBe(true);
    const returnedOrgIds = sharedLoginRes.body.organizations.map((o: { id: string }) => o.id);
    expect(returnedOrgIds.sort()).toEqual([orgA.organizationId, orgB.organizationId].sort());

    const selectRes = await sharedAgent
      .post(`${API}/auth/select-organization`)
      .send({ organizationId: orgB.organizationId })
      .expect(200);
    expect(selectRes.body.organizationId).toBe(orgB.organizationId);
    expect(selectRes.body.roles).toContain('DISPATCHER');

    // Legitimate switch: the shared identity genuinely belongs to Org A too.
    await sharedAgent
      .post(`${API}/auth/switch-organization`)
      .send({ organizationId: orgA.organizationId })
      .expect(200);

    // resolveOrganizationSession must still reject an org the authenticated
    // user does NOT belong to — proves the bootstrap fix didn't turn the
    // membership check into a rubber stamp.
    await sharedAgent
      .post(`${API}/auth/switch-organization`)
      .send({ organizationId: '00000000-0000-0000-0000-000000000000' })
      .expect(401);
  });

  // -----------------------------------------------------------------------
  // 9: existing cross-tenant application/RLS proof in identity.e2e-spec.ts
  // and core-master-data.e2e-spec.ts is unaffected by this suite — verified
  // by running the full test:e2e suite together (see Phase 2 verification
  // report), not by a test in this file.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // 10–12: the identity-bootstrap exceptions themselves must not widen
  // access beyond exactly what they're for — a user's own memberships only,
  // never another user's, and never any other table.
  // -----------------------------------------------------------------------

  it("10. app.current_user_id reveals only the matching user's own membership rows, never another user's", async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      const rows = await withUserContext(
        solo,
        orgA.adminUserId,
        (tx) =>
          tx.$queryRaw<
            { user_id: string }[]
          >`SELECT user_id FROM organization_membership WHERE user_id = ${orgB.adminUserId}::uuid`,
      );
      expect(rows).toHaveLength(0);

      const ownRows = await withUserContext(
        solo,
        orgA.adminUserId,
        (tx) =>
          tx.$queryRaw<
            { user_id: string }[]
          >`SELECT user_id FROM organization_membership WHERE user_id = ${orgA.adminUserId}::uuid`,
      );
      expect(ownRows.length).toBeGreaterThan(0);
      expect(ownRows.every((r) => r.user_id === orgA.adminUserId)).toBe(true);
    } finally {
      await solo.$disconnect();
    }
  });

  it('11. app.current_user_id grants no access to unrelated RLS-protected tables (e.g. customer)', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      // Seed a real customer row for Org A via the trusted, known-org path.
      await prisma.withTenantTransaction(orgA.organizationId, (tx) =>
        tx.customer.create({
          data: {
            organizationId: orgA.organizationId,
            legalName: 'RLS Suite Test Customer',
            billingAddressLine1: '1 Test St',
            billingCity: 'Springfield',
            billingState: 'IL',
            billingZip: '62701',
            primaryContactName: 'Test Contact',
            primaryContactEmail: 'contact@rls-suite-customer.test',
            primaryContactPhone: '555-0199',
            paymentTerms: 'NET_30',
            paymentTermsSource: 'OVERRIDE',
            createdByUserId: orgA.adminUserId,
          },
        }),
      );

      const rows = await withUserContext(
        solo,
        orgA.adminUserId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM customer WHERE organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await solo.$disconnect();
    }
  });

  it('12. app.current_invitation_token_hash reveals only the matching invitation, and an unset/wrong hash reveals nothing', async () => {
    const solo = new PrismaClient({ datasources: { db: { url: soloConnectionUrl() } } });
    try {
      await orgA.agent
        .post(`${API}/memberships/invite`)
        .send({ email: 'token-scope-check@rls-suite.test', roles: ['DISPATCHER'] })
        .expect(201);
      const realToken = extractToken(lastEmailTo('token-scope-check@rls-suite.test').body);
      const realHash = createHash('sha256').update(realToken).digest('hex');

      const withWrongHash = await solo.$transaction((tx) =>
        tx.$executeRaw`SELECT set_config('app.current_invitation_token_hash', 'not-a-real-hash', true)`.then(
          () =>
            tx.$queryRaw<
              unknown[]
            >`SELECT * FROM organization_membership WHERE invitation_token_hash = ${realHash}`,
        ),
      );
      expect(withWrongHash).toHaveLength(0);

      const withRealHash = await solo.$transaction((tx) =>
        tx.$executeRaw`SELECT set_config('app.current_invitation_token_hash', ${realHash}, true)`.then(
          () =>
            tx.$queryRaw<
              { invitation_token_hash: string }[]
            >`SELECT invitation_token_hash FROM organization_membership WHERE invitation_token_hash = ${realHash}`,
        ),
      );
      expect(withRealHash).toHaveLength(1);
      expect(withRealHash[0].invitation_token_hash).toBe(realHash);
    } finally {
      await solo.$disconnect();
    }
  });
});
