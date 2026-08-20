import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { InvitationExpirationSweepService } from '../src/modules/background-jobs/services/invitation-expiration-sweep.service';
import { QuoteExpirationSweepService } from '../src/modules/background-jobs/services/quote-expiration-sweep.service';
import { CarrierComplianceExpirationSweepService } from '../src/modules/background-jobs/services/carrier-compliance-expiration-sweep.service';
import { ComplianceExpirationNotificationService } from '../src/modules/background-jobs/services/compliance-expiration-notification.service';
import { CheckCallReminderSweepService } from '../src/modules/background-jobs/services/check-call-reminder-sweep.service';

type SuperAgentTest = ReturnType<typeof request.agent>;

/** Every route except /health sits behind the global prefix (main.ts / configure-app.ts). */
const API = '/api/v1';

const LOAD_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    addressLine1: '2 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
];

/** Workflow 4 §4.2 — Quote stops are lane-level only (city/state/zip), a narrower shape than Load stops. */
const QUOTE_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    addressCity: 'Dallas',
    addressState: 'TX',
    addressZip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    addressCity: 'Chicago',
    addressState: 'IL',
    addressZip: '60601',
  },
];

const DISPATCH_BODY = {
  driverName: 'Jane Driver',
  driverPhone: '555-9000',
  truckNumber: 'T-100',
  trailerNumber: 'TR-100',
};

/**
 * Phase 7 (Notifications & Background Jobs) end-to-end proof. These are
 * time-based sweeps with no HTTP trigger — each job's `run()` method is
 * invoked directly (via `app.get(ServiceClass)`), exactly matching how the
 * real BullMQ Worker dispatches to it (`scheduled-jobs.worker.ts`'s
 * `processJob` switch statement), rather than waiting on a real BullMQ
 * repeat schedule.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Notifications & Background Jobs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'notifications-jobs-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let opsManagerAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let orgId: string;

  let w9TypeId: string;
  let coiTypeId: string;
  let carrierAgreementTypeId: string;
  let mcAuthorityTypeId: string;

  let invitationSweep: InvitationExpirationSweepService;
  let quoteSweep: QuoteExpirationSweepService;
  let complianceSweep: CarrierComplianceExpirationSweepService;
  let complianceNotifications: ComplianceExpirationNotificationService;
  let checkCallSweep: CheckCallReminderSweepService;

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

    invitationSweep = app.get(InvitationExpirationSweepService);
    quoteSweep = app.get(QuoteExpirationSweepService);
    complianceSweep = app.get(CarrierComplianceExpirationSweepService);
    complianceNotifications = app.get(ComplianceExpirationNotificationService);
    checkCallSweep = app.get(CheckCallReminderSweepService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Notifications & Jobs Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const types = await Promise.all(
      [
        { code: 'W9', label: 'W9', requiresReview: true },
        { code: 'COI', label: 'Certificate of Insurance', requiresReview: true },
        { code: 'CARRIER_AGREEMENT', label: 'Carrier Agreement', requiresReview: true },
        { code: 'MC_AUTHORITY', label: 'MC Authority', requiresReview: true },
      ].map((t) =>
        prisma.documentTypeDefinition.create({
          data: {
            organizationId: null,
            category: 'CARRIER_COMPLIANCE',
            isSystemDefault: true,
            ...t,
          },
        }),
      ),
    );
    [w9TypeId, coiTypeId, carrierAgreementTypeId, mcAuthorityTypeId] = types.map((t) => t.id);

    const org = await setUpOrganization('main');
    orgId = org.organizationId;
    adminAgent = org.adminAgent;
    dispatcherAgent = org.dispatcherAgent;
    opsManagerAgent = org.opsManagerAgent;
    reviewerAgent = org.reviewerAgent;
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

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }

  async function setUpOrganization(seed: string) {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@notifications-jobs-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@notifications-jobs-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@notifications-jobs-test.test`;
    const reviewerEmail = `reviewer-${seed}@notifications-jobs-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Notifications & Jobs Test Org ${seed}`,
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

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: opsManagerEmail, roles: ['OPERATIONS_MANAGER'] })
      .expect(201);
    const opsManagerAgentLocal = await activateAndLogin(opsManagerEmail, 'OpsManagerPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerAgentLocal = await activateAndLogin(reviewerEmail, 'ReviewerPass123');

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
      opsManagerAgent: opsManagerAgentLocal,
      reviewerAgent: reviewerAgentLocal,
    };
  }

  async function createActiveCustomer(agent: SuperAgentTest, seed: string): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Notifications Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@notifications-jobs-customer.test`,
        primaryContactPhone: '555-0200',
        acknowledgeDuplicates: true,
      })
      .expect(201);
    const customerId: string = res.body.id;
    await agent
      .post(`${API}/customers/${customerId}/status`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    return customerId;
  }

  async function uploadAndConfirm(
    agent: SuperAgentTest,
    carrierId: string,
    documentTypeId: string,
    fileName: string,
    expirationDate?: string,
  ): Promise<string> {
    const initiateRes = await agent
      .post(`${API}/carriers/${carrierId}/documents`)
      .send({
        documentTypeId,
        fileName,
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
        ...(expirationDate ? { expirationDate } : {}),
      })
      .expect(201);
    const documentId: string = initiateRes.body.document.id;
    const uploadUrl: string = initiateRes.body.uploadUrl;

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 fake test content'),
    });

    await agent.post(`${API}/documents/${documentId}/confirm`).expect(200);
    return documentId;
  }

  async function waitForScanStatus(documentId: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const doc = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: documentId } }),
      );
      if (doc && doc.scanStatus !== 'PENDING') return doc.scanStatus;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Document ${documentId} scan did not complete within ${timeoutMs}ms`);
  }

  /** Full onboarding-to-Active sequence (Workflow 3), with an optional past expirationDate on the MC Authority doc so the compliance sweep has something to act on. */
  async function createEligibleCarrier(
    seed: string,
    mcAuthorityExpirationDate?: string,
  ): Promise<string> {
    const res = await adminAgent
      .post(`${API}/carriers`)
      .send({
        legalName: `Eligible Carrier ${seed}`,
        mcNumber: `MC-${seed}`,
        dotNumber: `DOT-${seed}`,
        addressLine1: '5 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        primaryContactName: 'Carrier Dispatch',
        primaryContactPhone: '555-0300',
        primaryContactEmail: `dispatch-${seed}@carrier-test.test`,
      })
      .expect(201);
    const carrierId: string = res.body.id;

    const w9Id = await uploadAndConfirm(adminAgent, carrierId, w9TypeId, 'w9.pdf');
    const caId = await uploadAndConfirm(
      adminAgent,
      carrierId,
      carrierAgreementTypeId,
      'agreement.pdf',
    );
    const mcId = await uploadAndConfirm(
      adminAgent,
      carrierId,
      mcAuthorityTypeId,
      'mc-authority.pdf',
      mcAuthorityExpirationDate,
    );
    const coiId = await uploadAndConfirm(adminAgent, carrierId, coiTypeId, 'coi.pdf');
    for (const id of [w9Id, caId, mcId, coiId]) {
      expect(await waitForScanStatus(id)).toBe('CLEAN');
    }
    for (const id of [w9Id, caId, mcId, coiId]) {
      await reviewerAgent
        .post(`${API}/carriers/${carrierId}/documents/${id}/review`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    }
    for (const coverageType of ['AUTO_LIABILITY', 'CARGO']) {
      await adminAgent
        .post(`${API}/carriers/${carrierId}/insurance`)
        .send({
          coverageType,
          coverageAmount: '1000000.00',
          insuranceCompany: 'Test Insurance Co',
          effectiveDate: '2026-01-01',
          expirationDate: '2030-01-01',
          coiDocumentId: coiId,
        })
        .expect(201);
    }
    await reviewerAgent
      .post(`${API}/carriers/${carrierId}/fmcsa-verification`)
      .send({ verificationDate: '2026-01-01', resultStatus: 'Authorized' })
      .expect(201);
    await reviewerAgent.post(`${API}/carriers/${carrierId}/activate`).expect(200);
    return carrierId;
  }

  async function createBookedLoad(seed: string): Promise<string> {
    const customerId = await createActiveCustomer(adminAgent, seed);
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
      .expect(201);
    return res.body.id;
  }

  async function progressToDispatched(loadId: string, carrierId: string): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate: '1500.00' })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
  }

  describe('Document expirationDate capture — Phase 7 Decision 2 (additive)', () => {
    it('accepts and persists an optional expirationDate on a carrier document upload', async () => {
      const carrierRes = await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'Expiration Capture Carrier',
          mcNumber: 'MC-EXPCAP-1',
          dotNumber: 'DOT-EXPCAP-1',
          addressLine1: '9 Dock Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Someone',
          primaryContactPhone: '555-0301',
          primaryContactEmail: 'expcap@carrier-test.test',
        })
        .expect(201);
      const carrierId: string = carrierRes.body.id;

      const documentId = await uploadAndConfirm(
        adminAgent,
        carrierId,
        mcAuthorityTypeId,
        'mc-authority.pdf',
        '2020-01-01',
      );

      const doc = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: documentId } }),
      );
      expect(doc?.expirationDate?.toISOString().slice(0, 10)).toBe('2020-01-01');
    });
  });

  describe('Invitation Expiration Sweep — Workflow 1 §1.6 (proactive housekeeping)', () => {
    it('flips a stale INVITED membership to EXPIRED without anyone touching it', async () => {
      const staleEmail = 'stale-invite@notifications-jobs-test.test';
      await adminAgent
        .post(`${API}/memberships/invite`)
        .send({ email: staleEmail, roles: ['ACCOUNTING'] })
        .expect(201);

      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.organizationMembership.updateMany({
          where: { organizationId: orgId, user: { email: staleEmail } },
          data: { invitationExpiresAt: new Date('2020-01-01') },
        }),
      );

      await invitationSweep.run();

      const membership = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.organizationMembership.findFirst({
          where: { organizationId: orgId, user: { email: staleEmail } },
        }),
      );
      expect(membership?.status).toBe('EXPIRED');
    });
  });

  describe('Quote Expiration Sweep — Workflow 4 §4.5', () => {
    it('marks a stale OPEN quote LOST with an automatic loss reason', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'quote-sweep');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({
          customerId,
          stops: QUOTE_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '1200.00',
        })
        .expect(201);
      const quoteId: string = quoteRes.body.id;

      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.quote.update({
          where: { id: quoteId },
          data: { expirationDate: new Date('2020-01-01') },
        }),
      );

      await quoteSweep.run();

      const quote = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.quote.findUnique({ where: { id: quoteId } }),
      );
      expect(quote?.status).toBe('LOST');
      expect(quote?.lossReason).toBe('Expired');
    });

    it('never touches a Quote that is not yet expired', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'quote-sweep-not-expired');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({
          customerId,
          stops: QUOTE_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '1200.00',
        })
        .expect(201);

      await quoteSweep.run();

      const quote = await adminAgent.get(`${API}/quotes/${quoteRes.body.id}`).expect(200);
      expect(quote.body.status).toBe('OPEN');
    });
  });

  describe('Carrier Compliance Expiration Sweep — Workflow 3 §3.9', () => {
    it('expires a stale MC Authority document and flips assignment_eligible to No', async () => {
      const carrierId = await createEligibleCarrier('compliance-sweep', '2020-01-01');

      const before = await adminAgent.get(`${API}/carriers/${carrierId}`).expect(200);
      expect(before.body.assignmentEligible).toBe(true);

      await complianceSweep.run();

      const after = await adminAgent.get(`${API}/carriers/${carrierId}`).expect(200);
      expect(after.body.assignmentEligible).toBe(false);
      expect(after.body.ineligibilityReasons.length).toBeGreaterThan(0);
    });

    it('leaves a fully-compliant carrier eligible', async () => {
      const carrierId = await createEligibleCarrier('compliance-sweep-clean', '2030-01-01');

      await complianceSweep.run();

      const after = await adminAgent.get(`${API}/carriers/${carrierId}`).expect(200);
      expect(after.body.assignmentEligible).toBe(true);
    });
  });

  describe('Compliance Expiration Notifications — Workflow 3 §3.10', () => {
    it('notifies every Operations Manager and Compliance Reviewer once for an item entering the 30-day window', async () => {
      const in25Days = new Date();
      in25Days.setDate(in25Days.getDate() + 25);
      const carrierId = await createEligibleCarrier(
        'compliance-notify',
        in25Days.toISOString().slice(0, 10),
      );

      await complianceNotifications.run();

      const documents = await adminAgent
        .get(`${API}/documents`)
        .query({ entityType: 'CARRIER', entityId: carrierId })
        .expect(200);
      const mcAuthorityDoc = documents.body.find(
        (d: { fileName: string }) => d.fileName === 'mc-authority.pdf',
      );

      const opsNotifications = await opsManagerAgent.get(`${API}/notifications`).expect(200);
      expect(
        opsNotifications.body.some(
          (n: { type: string; relatedEntityType: string; relatedEntityId: string }) =>
            n.type === 'COMPLIANCE_EXPIRING_30_DAY' &&
            n.relatedEntityType === 'Document' &&
            n.relatedEntityId === mcAuthorityDoc.id,
        ),
      ).toBe(true);

      const reviewerNotifications = await reviewerAgent.get(`${API}/notifications`).expect(200);
      expect(reviewerNotifications.body.length).toBeGreaterThan(0);

      // Dispatcher holds neither role — never notified.
      const dispatcherNotifications = await dispatcherAgent.get(`${API}/notifications`).expect(200);
      expect(dispatcherNotifications.body).toHaveLength(0);

      // "Each fires once" — running the sweep again must not duplicate.
      await complianceNotifications.run();
      const opsNotificationsAfterRerun = await opsManagerAgent
        .get(`${API}/notifications`)
        .expect(200);
      expect(opsNotificationsAfterRerun.body.length).toBe(opsNotifications.body.length);
    });
  });

  describe('Check-Call Reminder Sweep — TECHNICAL_ARCHITECTURE.md §10.1 (B1, 4h)', () => {
    it('notifies the assigned dispatcher once a Load goes quiet past the interval', async () => {
      const carrierId = await createEligibleCarrier('checkcall-sweep');
      const loadId = await createBookedLoad('checkcall-sweep');
      const dispatcherUserId = await currentUserId(dispatcherAgent);
      await adminAgent
        .patch(`${API}/loads/${loadId}/dispatcher`)
        .send({ dispatcherUserId })
        .expect(200);
      await progressToDispatched(loadId, carrierId);

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.dispatchRecord.update({ where: { loadId }, data: { dispatchedAt: fiveHoursAgo } }),
      );

      await checkCallSweep.run();

      const notifications = await dispatcherAgent.get(`${API}/notifications`).expect(200);
      expect(
        notifications.body.some(
          (n: { type: string; relatedEntityId: string }) =>
            n.type === 'CHECK_CALL_OVERDUE' && n.relatedEntityId === loadId,
        ),
      ).toBe(true);
    });

    it('skips a Load with no assigned dispatcher (Decision 5)', async () => {
      const carrierId = await createEligibleCarrier('checkcall-sweep-no-dispatcher');
      const loadId = await createBookedLoad('checkcall-sweep-no-dispatcher');
      await progressToDispatched(loadId, carrierId);

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.dispatchRecord.update({ where: { loadId }, data: { dispatchedAt: fiveHoursAgo } }),
      );

      await checkCallSweep.run();

      const opsManagerNotifications = await opsManagerAgent.get(`${API}/notifications`).expect(200);
      expect(
        opsManagerNotifications.body.some(
          (n: { relatedEntityId: string }) => n.relatedEntityId === loadId,
        ),
      ).toBe(false);
    });

    it('does not notify while a Load remains within the interval', async () => {
      const carrierId = await createEligibleCarrier('checkcall-sweep-fresh');
      const loadId = await createBookedLoad('checkcall-sweep-fresh');
      const dispatcherUserId = await currentUserId(dispatcherAgent);
      await adminAgent
        .patch(`${API}/loads/${loadId}/dispatcher`)
        .send({ dispatcherUserId })
        .expect(200);
      await progressToDispatched(loadId, carrierId);

      await checkCallSweep.run();

      const notifications = await dispatcherAgent.get(`${API}/notifications`).expect(200);
      expect(
        notifications.body.some((n: { relatedEntityId: string }) => n.relatedEntityId === loadId),
      ).toBe(false);
    });
  });

  describe('Notification API — GET /notifications, POST :id/read, POST mark-all-read', () => {
    it('lets a recipient list, mark one read, and mark all read — self-scoped only', async () => {
      const carrierId = await createEligibleCarrier('notif-api');
      const loadId = await createBookedLoad('notif-api');
      const dispatcherUserId = await currentUserId(dispatcherAgent);
      await adminAgent
        .patch(`${API}/loads/${loadId}/dispatcher`)
        .send({ dispatcherUserId })
        .expect(200);
      await progressToDispatched(loadId, carrierId);
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.dispatchRecord.update({ where: { loadId }, data: { dispatchedAt: fiveHoursAgo } }),
      );
      await checkCallSweep.run();

      const list = await dispatcherAgent.get(`${API}/notifications`).expect(200);
      expect(list.body.length).toBeGreaterThan(0);
      const notificationId = list.body[0].id;

      const readRes = await dispatcherAgent
        .post(`${API}/notifications/${notificationId}/read`)
        .expect(200);
      expect(readRes.body.read).toBe(true);

      const markAllRes = await dispatcherAgent
        .post(`${API}/notifications/mark-all-read`)
        .expect(200);
      expect(markAllRes.body.count).toBeGreaterThanOrEqual(0);

      const unreadOnly = await dispatcherAgent
        .get(`${API}/notifications`)
        .query({ unreadOnly: 'true' })
        .expect(200);
      expect(unreadOnly.body).toHaveLength(0);

      // Another user cannot mark someone else's notification read.
      await opsManagerAgent.post(`${API}/notifications/${notificationId}/read`).expect(404);
    });
  });

  describe('Cross-tenant isolation for the notification table', () => {
    it("one organization's notifications are never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const opsManagerUserId = await currentUserId(orgA.opsManagerAgent);
      await prisma.withTenantTransaction(orgA.organizationId, (tx) =>
        tx.notification.create({
          data: {
            organizationId: orgA.organizationId,
            recipientUserId: opsManagerUserId,
            type: 'CHECK_CALL_OVERDUE',
            message: 'Cross-tenant isolation probe.',
          },
        }),
      );

      const orgBList = await orgB.opsManagerAgent.get(`${API}/notifications`).expect(200);
      expect(orgBList.body).toHaveLength(0);

      const rowsVisibleFromWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM notification WHERE organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromWrongTenant).toHaveLength(0);

      const rowsWithNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM notification WHERE organization_id = ${orgA.organizationId}::uuid`;
      expect(rowsWithNoContext).toHaveLength(0);
    }, 30000);
  });
});
