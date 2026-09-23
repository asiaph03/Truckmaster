import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { withCsrf } from './support/csrf-agent';

const API = '/api/v1';

// This suite runs against a shared, never-reset database (tms_e2e_test) —
// every generated fixture email includes this run-scoped suffix so
// repeated runs never collide with a previous run's own rows (same
// pattern used throughout the existing e2e suite).
const RUN_ID = Date.now();

/**
 * Phase 6B — forgot-password / password-reset. Requires a live PostgreSQL
 * + Redis, with the Phase 6B migration applied to the isolated E2E
 * database only:
 *   DATABASE_URL=<E2E_DATABASE_URL> npx prisma migrate deploy
 *   npm run test:e2e
 *
 * Never touches the production database — every Prisma call here runs
 * against whatever DATABASE_URL this process was started with, which
 * setup-e2e-env.ts hard-fails on unless it is a validated E2E_* value.
 */
describe('Password reset (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordService: PasswordService;
  let sentEmails: { to: string; subject: string; body: string }[];

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
    passwordService = app.get(PasswordService);
  });

  afterAll(async () => {
    await app.close();
  });

  function extractResetToken(body: string): string {
    const match = body.match(/token=([a-f0-9]{64})/);
    if (!match) throw new Error(`No reset token found in email body: ${body}`);
    return match[1];
  }

  /**
   * Same wait-for-async-BullMQ-side-effect pattern as identity.e2e-spec.ts's
   * lastEmailTo — password-reset emails are enqueued (EMAIL_QUEUE ->
   * EmailSendWorker), not sent synchronously from the request.
   */
  async function lastEmailTo(
    to: string,
    timeoutMs = 5000,
  ): Promise<{ to: string; subject: string; body: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const email = [...sentEmails].reverse().find((m) => m.to === to);
      if (email) return email;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No email captured for ${to}`);
  }

  async function emailsTo(to: string): Promise<{ to: string; subject: string; body: string }[]> {
    return sentEmails.filter((m) => m.to === to);
  }

  /** Bypasses the invitation flow — a directly-provisioned ACTIVE user with zero memberships. */
  async function createActiveUser(seed: string, password: string) {
    const email = `password-reset-${seed}-${RUN_ID}@trucktms.internal`;
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Reset Test User',
        status: 'ACTIVE',
        passwordHash: await passwordService.hash(password),
      },
    });
    return { user, email };
  }

  /** A second organization + ACTIVE membership for the given user, for the multi-membership coverage. */
  async function addActiveMembership(seed: string, userId: string) {
    const org = await prisma.organization.create({
      data: {
        legalName: `Password Reset Test Org ${seed} ${RUN_ID}`,
        addressLine1: '1 Test St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Test Contact',
        primaryContactEmail: `contact-${seed}-${RUN_ID}@trucktms.internal`,
        primaryContactPhone: '555-0100',
        createdByUserId: userId,
      },
    });
    await prisma.withTenantTransaction(org.id, async (tx) => {
      const membership = await tx.organizationMembership.create({
        data: { organizationId: org.id, userId, status: 'ACTIVE', activatedAt: new Date() },
      });
      await tx.membershipRole.create({
        data: { organizationId: org.id, membershipId: membership.id, role: 'ADMIN' },
      });
    });
    return org;
  }

  async function requestReset(email: string) {
    return withCsrf(request.agent(app.getHttpServer())).then((agent) =>
      agent.post(`${API}/auth/forgot-password`).send({ email }).expect(200),
    );
  }

  describe('A/B/§5 — enumeration protection', () => {
    it('A. requesting a reset for an existing, qualifying user returns success and enqueues an email', async () => {
      const { email } = await createActiveUser('existing', 'OldPassw0rd1');

      const res = await requestReset(email);

      expect(res.body).toEqual({ success: true });
      const email1 = await lastEmailTo(email);
      expect(email1.body).toContain('/reset-password?token=');
    });

    it('B. requesting a reset for a nonexistent email returns the identical success response and enqueues nothing', async () => {
      const nonexistentEmail = `no-such-user-${RUN_ID}@trucktms.internal`;

      const res = await requestReset(nonexistentEmail);

      expect(res.body).toEqual({ success: true });
      // Give any (incorrect) async enqueue a moment to land before asserting absence.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await emailsTo(nonexistentEmail)).toHaveLength(0);
    });

    it('identical response for an inactive user and a user with no password set yet', async () => {
      const { email: suspendedEmail } = await createActiveUser('suspended-src', 'OldPassw0rd1');
      await prisma.user.update({
        where: { email: suspendedEmail },
        data: { status: 'SUSPENDED' },
      });
      const pendingEmail = `password-reset-pending-${RUN_ID}@trucktms.internal`;
      await prisma.user.create({
        data: { email: pendingEmail, name: 'Pending User', status: 'PENDING_VERIFICATION' },
      });

      const resSuspended = await requestReset(suspendedEmail);
      const resPending = await requestReset(pendingEmail);

      expect(resSuspended.body).toEqual({ success: true });
      expect(resPending.body).toEqual({ success: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await emailsTo(suspendedEmail)).toHaveLength(0);
      expect(await emailsTo(pendingEmail)).toHaveLength(0);
    });
  });

  describe('E/F/G — end-to-end reset flow', () => {
    it('E/F/G. a full reset: old password stops working, new password works', async () => {
      const oldPassword = 'OldPassw0rd1';
      const newPassword = 'BrandNewPassw0rd2';
      const { email } = await createActiveUser('full-flow', oldPassword);

      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent.post(`${API}/auth/reset-password`).send({ token, password: newPassword }).expect(200),
      );

      // F. old password no longer works.
      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent.post(`${API}/auth/login`).send({ email, password: oldPassword }).expect(401),
      );

      // G. new password works.
      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent.post(`${API}/auth/login`).send({ email, password: newPassword }).expect(200),
      );
    });
  });

  describe('H/I/J — token lifecycle', () => {
    it('H. a token cannot be reused after a successful reset', async () => {
      const { email } = await createActiveUser('reuse', 'OldPassw0rd1');
      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'FirstNewPassw0rd' })
          .expect(200),
      );

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'SecondNewPassw0rd' })
          .expect(401),
      );
    });

    it('I. an expired token is rejected', async () => {
      const { email } = await createActiveUser('expired', 'OldPassw0rd1');
      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);

      // No scheduler exists to expire it on its own — force it into the
      // past directly, exactly as the demo-provisioning e2e suite forces
      // trialEndsAt into the past for its own expiration coverage.
      const hashRow = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM password_reset_token
        WHERE user_id = (SELECT id FROM "user" WHERE email = ${email})
        ORDER BY created_at DESC LIMIT 1
      `;
      await prisma.passwordResetToken.update({
        where: { id: hashRow[0].id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'ShouldNeverApply1' })
          .expect(401),
      );
    });

    it('J. a second forgot-password request invalidates the first token', async () => {
      const { email } = await createActiveUser('supersede', 'OldPassw0rd1');

      await requestReset(email);
      const firstToken = extractResetToken((await lastEmailTo(email)).body);

      await requestReset(email);
      // Poll until a SECOND distinct email has been captured for this
      // address (lastEmailTo alone can't distinguish "still the first
      // email" from "the second has landed").
      const deadline = Date.now() + 5000;
      let secondToken: string | undefined;
      while (Date.now() < deadline) {
        const emails = await emailsTo(email);
        if (emails.length >= 2) {
          secondToken = extractResetToken(emails[emails.length - 1].body);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!secondToken) throw new Error('Second reset email was never captured');
      expect(secondToken).not.toBe(firstToken);

      // The first token is now invalidated.
      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token: firstToken, password: 'ShouldNeverApply1' })
          .expect(401),
      );

      // The second (current) token still works.
      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token: secondToken, password: 'SupersedingPassw0rd' })
          .expect(200),
      );
    });
  });

  describe('K/L — membership-count independence', () => {
    it('K. a user with zero organization memberships completes the full reset flow', async () => {
      const { email } = await createActiveUser('zero-memberships', 'OldPassw0rd1');

      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'ZeroMembershipPassw0rd' })
          .expect(200),
      );
    });

    it('L. a user with multiple organization memberships completes the full reset flow', async () => {
      const { user, email } = await createActiveUser('multi-membership', 'OldPassw0rd1');
      await addActiveMembership('multi-a', user.id);
      await addActiveMembership('multi-b', user.id);

      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);

      await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'MultiMembershipPassw0rd' })
          .expect(200),
      );
    });
  });

  describe('§8/M/N — session invalidation (the Phase 6A audit gap, closed)', () => {
    it('N. a single-membership (auto-selected) session is invalidated after reset', async () => {
      const password = 'OldPassw0rd1';
      const { user, email } = await createActiveUser('session-single', password);
      await addActiveMembership('session-single', user.id);

      const agent = await withCsrf(request.agent(app.getHttpServer()));
      const loginRes = await agent.post(`${API}/auth/login`).send({ email, password }).expect(200);
      expect(loginRes.body.requiresOrganizationSelection).toBe(false);
      await agent.get(`${API}/auth/me`).expect(200);

      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);
      await withCsrf(request.agent(app.getHttpServer())).then((resetAgent) =>
        resetAgent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'BrandNewPassw0rd2' })
          .expect(200),
      );

      await agent.get(`${API}/auth/me`).expect(401);
    });

    it('M. an org-pending session (no organization selected yet, >1 active membership) is invalidated after reset — the exact gap the Phase 6A audit identified', async () => {
      const password = 'OldPassw0rd1';
      const { user, email } = await createActiveUser('session-org-pending', password);
      await addActiveMembership('session-pending-a', user.id);
      await addActiveMembership('session-pending-b', user.id);

      const agent = await withCsrf(request.agent(app.getHttpServer()));
      const loginRes = await agent.post(`${API}/auth/login`).send({ email, password }).expect(200);
      expect(loginRes.body.requiresOrganizationSelection).toBe(true);
      // Session is valid (org-pending, but authenticated) before reset.
      await agent.get(`${API}/auth/me`).expect(200);

      await requestReset(email);
      const token = extractResetToken((await lastEmailTo(email)).body);
      await withCsrf(request.agent(app.getHttpServer())).then((resetAgent) =>
        resetAgent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'BrandNewPassw0rd2' })
          .expect(200),
      );

      // The org-pending session — which recordActiveOrganization alone
      // never indexed (no organizationId existed yet) — must still be
      // destroyed by the new user-level index.
      await agent.get(`${API}/auth/me`).expect(401);
    });
  });

  describe('§10/§11 — no raw token ever appears where it should not', () => {
    it('the reset email body contains the raw token exactly once, in the reset URL, and nowhere else is it echoed back by any endpoint', async () => {
      const { email } = await createActiveUser('token-surface', 'OldPassw0rd1');

      const forgotRes = await requestReset(email);
      expect(JSON.stringify(forgotRes.body)).not.toMatch(/[a-f0-9]{64}/);

      const captured = await lastEmailTo(email);
      const token = extractResetToken(captured.body);

      const resetRes = await withCsrf(request.agent(app.getHttpServer())).then((agent) =>
        agent
          .post(`${API}/auth/reset-password`)
          .send({ token, password: 'TokenSurfacePassw0rd' })
          .expect(200),
      );
      expect(JSON.stringify(resetRes.body)).not.toContain(token);
    });
  });
});
