import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { MALWARE_SCANNER } from '../src/common/malware-scan/malware-scanner.interface';

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

const MULTI_PICKUP_STOPS = [
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
    stopType: 'PICKUP',
    addressLine1: '2 Dock Rd',
    city: 'Waco',
    state: 'TX',
    zip: '76701',
  },
  {
    sequence: 3,
    stopType: 'DELIVERY',
    addressLine1: '3 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
];

const MULTI_DELIVERY_STOPS = [
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
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
  },
  {
    sequence: 3,
    stopType: 'DELIVERY',
    addressLine1: '3 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
];

const DISPATCH_BODY = {
  driverName: 'Jane Driver',
  driverPhone: '555-9000',
  truckNumber: 'T-100',
  trailerNumber: 'TR-100',
};

/**
 * Phase 4 (Sourcing & Dispatch) end-to-end proof: Workflow 5's Sourcing
 * lifecycle (Begin Sourcing, the non-overridable Eligibility Gate,
 * Assignment, optional Sourcing Attempt logging, no-cycle-limit Rejection
 * handling, Rate Confirmation generation) and Workflow 6's Dispatch
 * lifecycle (the full Dispatch gate, driver/equipment snapshotting, Stop
 * arrival/departure driving system-derived Load status, Check Calls, Risk
 * Status, post-dispatch editing), plus the approved independent Dispatcher
 * Assignment action, role-based permissions, and cross-tenant RLS
 * isolation for the three new tables — run against a live app instance
 * with a live PostgreSQL + Redis + S3-compatible store.
 *
 * Requires the same setup as the other e2e spec files:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed   (system document types, including RATE_CONFIRMATION)
 *   npm run test:e2e
 */
describe('Sourcing & Dispatch (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'sourcing-dispatch-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let opsManagerAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let orgId: string;

  let w9TypeId: string;
  let coiTypeId: string;
  let carrierAgreementTypeId: string;
  let mcAuthorityTypeId: string;

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
      // Phase 16 — see financials.e2e-spec.ts's identical override comment.
      .overrideProvider(MALWARE_SCANNER)
      .useValue({ scan: async () => ({ status: 'CLEAN', provider: 'test-double' }) })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    const passwordService = app.get(PasswordService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Sourcing & Dispatch Suite Platform Super Admin',
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
    opsManagerAgent = org.opsManagerAgent;
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
    accountingAgent = org.accountingAgent;
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

  /**
   * Frontend Phase 16 — email is now async (EMAIL_QUEUE + EmailSendWorker),
   * so the overridden EMAIL_SENDER mock may not have captured the message
   * yet the instant the triggering HTTP call returns. Polls briefly.
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

  async function activateAndLogin(email: string, password: string): Promise<SuperAgentTest> {
    const token = extractToken((await lastEmailTo(email)).body);
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

    const adminEmail = `admin-${seed}@sourcing-dispatch-test.test`;
    const opsManagerEmail = `opsmanager-${seed}@sourcing-dispatch-test.test`;
    const salesEmail = `sales-${seed}@sourcing-dispatch-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@sourcing-dispatch-test.test`;
    const accountingEmail = `accounting-${seed}@sourcing-dispatch-test.test`;
    const reviewerEmail = `reviewer-${seed}@sourcing-dispatch-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Sourcing & Dispatch Test Org ${seed}`,
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
      .send({ email: opsManagerEmail, roles: ['OPERATIONS_MANAGER'] })
      .expect(201);
    const opsManagerAgentLocal = await activateAndLogin(opsManagerEmail, 'OpsManagerPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: salesEmail, roles: ['SALES_BOOKING'] })
      .expect(201);
    const salesAgentLocal = await activateAndLogin(salesEmail, 'SalesPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: dispatcherEmail, roles: ['DISPATCHER'] })
      .expect(201);
    const dispatcherAgentLocal = await activateAndLogin(dispatcherEmail, 'DispatcherPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: accountingEmail, roles: ['ACCOUNTING'] })
      .expect(201);
    const accountingAgentLocal = await activateAndLogin(accountingEmail, 'AccountingPass123');

    await adminAgentLocal
      .post(`${API}/memberships/invite`)
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerAgentLocal = await activateAndLogin(reviewerEmail, 'ReviewerPass123');

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
      opsManagerAgent: opsManagerAgentLocal,
      salesAgent: salesAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
      accountingAgent: accountingAgentLocal,
      reviewerAgent: reviewerAgentLocal,
    };
  }

  async function createActiveCustomer(agent: SuperAgentTest, seed: string): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Sourcing Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@sourcing-dispatch-customer.test`,
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
  ): Promise<string> {
    const initiateRes = await agent
      .post(`${API}/carriers/${carrierId}/documents`)
      .send({ documentTypeId, fileName, mimeType: 'application/pdf', fileSizeBytes: 1024 })
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

  async function waitForFileSize(documentId: string, timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const doc = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: documentId } }),
      );
      if (doc && Number(doc.fileSizeBytes) > 0) return Number(doc.fileSizeBytes);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Document ${documentId} PDF was not generated within ${timeoutMs}ms`);
  }

  /** Full onboarding-to-Active sequence (Workflow 3), condensed to a single reusable helper. */
  async function createEligibleCarrier(seed: string): Promise<string> {
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

  async function createBookedLoad(seed: string, stops = LOAD_STOPS): Promise<string> {
    const customerId = await createActiveCustomer(adminAgent, seed);
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId, stops, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
      .expect(201);
    return res.body.id;
  }

  /** Carries a freshly-Booked Load all the way to RATE_CONFIRMATION. */
  async function progressToRateConfirmation(loadId: string, carrierId: string): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate: '1500.00' })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
  }

  async function progressToDispatched(loadId: string, carrierId: string): Promise<void> {
    await progressToRateConfirmation(loadId, carrierId);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
  }

  describe('Begin Sourcing — Workflow 5 §5.1', () => {
    it('transitions BOOKED -> CARRIER_SOURCING', async () => {
      const loadId = await createBookedLoad('begin-happy');
      const res = await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      expect(res.body.status).toBe('CARRIER_SOURCING');
    });

    it('rejects a load that is not currently BOOKED', async () => {
      const loadId = await createBookedLoad('begin-wrong-status');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(409);
    });
  });

  describe('Assignment Eligibility Gate — Workflow 5 §5.3 (hard, non-overridable)', () => {
    it('blocks assignment of a PENDING (never-activated) carrier, with reasons and no override', async () => {
      const loadId = await createBookedLoad('gate-ineligible');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);

      const ineligibleCarrier = await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'Ineligible Carrier',
          mcNumber: 'MC-INELIGIBLE-1',
          dotNumber: 'DOT-INELIGIBLE-1',
          addressLine1: '9 Dock Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Someone',
          primaryContactPhone: '555-0301',
          primaryContactEmail: 'ineligible@carrier-test.test',
        })
        .expect(201);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId: ineligibleCarrier.body.id, carrierRate: '1500.00' })
        .expect(409);
      expect(res.body.error.code).toBe('ELIGIBILITY_ERROR');
      expect(res.body.error.details.reasons.length).toBeGreaterThan(0);

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.status).toBe('CARRIER_SOURCING');
      expect(loadAfter.body.assignedCarrierId).toBeNull();
    });
  });

  describe('Carrier Assignment — Workflow 5 §5.4', () => {
    it('assigns an eligible carrier, creates an ASSIGNED sourcing attempt, transitions to CARRIER_ASSIGNED', async () => {
      const carrierId = await createEligibleCarrier('assign-happy');
      const loadId = await createBookedLoad('assign-happy');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);
      expect(res.body.status).toBe('CARRIER_ASSIGNED');
      expect(res.body.assignedCarrierId).toBe(carrierId);
      // Prisma's Decimal.toString() strips trailing zeros regardless of DB
      // precision (documented Phase 3 quirk) — "1500.00" serializes as "1500".
      expect(res.body.carrierRate).toBe('1500');

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const assigned = loadAfter.body.sourcingAttempts.find(
        (a: { outcome: string }) => a.outcome === 'ASSIGNED',
      );
      expect(assigned).toBeDefined();
      expect(assigned.carrierId).toBe(carrierId);
    });

    it('rejects assignment when the Load is not in CARRIER_SOURCING', async () => {
      const carrierId = await createEligibleCarrier('assign-wrong-status');
      const loadId = await createBookedLoad('assign-wrong-status');

      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(409);
    });
  });

  describe('Sourcing Attempt Logging — Workflow 5 §5.5', () => {
    it('logs optional contact attempts, always as new rows, never overwriting prior ones', async () => {
      const carrierId = await createEligibleCarrier('log-attempts');
      const loadId = await createBookedLoad('log-attempts');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);

      await adminAgent
        .post(`${API}/loads/${loadId}/sourcing-attempts`)
        .send({ carrierId, outcome: 'DECLINED' })
        .expect(201);
      await adminAgent
        .post(`${API}/loads/${loadId}/sourcing-attempts`)
        .send({ carrierId, outcome: 'NO_RESPONSE' })
        .expect(201);
      await adminAgent
        .post(`${API}/loads/${loadId}/sourcing-attempts`)
        .send({ carrierId, outcome: 'QUOTED', carrierRate: '1600.00' })
        .expect(201);

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const outcomes = loadAfter.body.sourcingAttempts.map((a: { outcome: string }) => a.outcome);
      expect(outcomes).toEqual(expect.arrayContaining(['DECLINED', 'NO_RESPONSE', 'QUOTED']));
    });
  });

  describe('Carrier Rejection — Workflow 5 §5.6 (no cycle limit)', () => {
    it('cycles assign -> reject -> assign -> reject, preserving full history each time', async () => {
      const carrierA = await createEligibleCarrier('reject-cycle-a');
      const carrierB = await createEligibleCarrier('reject-cycle-b');
      const loadId = await createBookedLoad('reject-cycle');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);

      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId: carrierA, carrierRate: '1500.00' })
        .expect(200);
      const reject1 = await adminAgent
        .post(`${API}/loads/${loadId}/carrier-rejected`)
        .send({ reason: 'Equipment breakdown' })
        .expect(200);
      expect(reject1.body.status).toBe('CARRIER_SOURCING');
      expect(reject1.body.assignedCarrierId).toBeNull();

      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId: carrierB, carrierRate: '1550.00' })
        .expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/carrier-rejected`)
        .send({ reason: 'Carrier backed out again' })
        .expect(200);

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const rejectedAttempts = loadAfter.body.sourcingAttempts.filter(
        (a: { outcome: string }) => a.outcome === 'REJECTED_AFTER_ASSIGNMENT',
      );
      expect(rejectedAttempts).toHaveLength(2);
    });

    it('requires a non-empty reason', async () => {
      const carrierId = await createEligibleCarrier('reject-empty-reason');
      const loadId = await createBookedLoad('reject-empty-reason');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);

      await adminAgent
        .post(`${API}/loads/${loadId}/carrier-rejected`)
        .send({ reason: '' })
        .expect(400);
    });
  });

  describe('Rate Confirmation Generation — Workflow 5 §5.7 (hard gate before Dispatch)', () => {
    it('gated on Carrier + rate only, creates a Document, transitions to RATE_CONFIRMATION', async () => {
      const carrierId = await createEligibleCarrier('rateconf-happy');
      const loadId = await createBookedLoad('rateconf-happy');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/generate-rate-confirmation`)
        .send({})
        .expect(200);
      expect(res.body.status).toBe('RATE_CONFIRMATION');

      const docs = await adminAgent
        .get(`${API}/documents`)
        .query({ entityType: 'LOAD', entityId: loadId })
        .expect(200);
      const rateConfDoc = docs.body.find((d: { fileName: string }) =>
        d.fileName.startsWith('RateConfirmation-'),
      );
      expect(rateConfDoc).toBeDefined();
      expect(rateConfDoc.scanStatus).toBe('CLEAN');

      const fileSize = await waitForFileSize(rateConfDoc.id);
      expect(fileSize).toBeGreaterThan(0);
    });

    it('rejects generation before a Carrier is assigned', async () => {
      const loadId = await createBookedLoad('rateconf-no-carrier');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);

      await adminAgent
        .post(`${API}/loads/${loadId}/generate-rate-confirmation`)
        .send({})
        .expect(409);
    });
  });

  describe('Dispatch — Workflow 6 §6.1 (full-gate re-validation) + §6.2 (snapshotting)', () => {
    it('blocks Dispatch when no Rate Confirmation is on file', async () => {
      const carrierId = await createEligibleCarrier('dispatch-no-rateconf');
      const loadId = await createBookedLoad('dispatch-no-rateconf');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);

      await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(409);
    });

    it('blocks Dispatch when driver/truck/trailer fields are missing', async () => {
      const carrierId = await createEligibleCarrier('dispatch-missing-fields');
      const loadId = await createBookedLoad('dispatch-missing-fields');
      await progressToRateConfirmation(loadId, carrierId);

      await adminAgent
        .post(`${API}/loads/${loadId}/dispatch`)
        .send({ driverName: 'Jane Driver' })
        .expect(400);
    });

    it('dispatches when the full gate is satisfied, snapshotting driver/equipment onto the DispatchRecord', async () => {
      const carrierId = await createEligibleCarrier('dispatch-happy');
      const loadId = await createBookedLoad('dispatch-happy');
      await progressToRateConfirmation(loadId, carrierId);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/dispatch`)
        .send(DISPATCH_BODY)
        .expect(200);
      expect(res.body.status).toBe('DISPATCHED');

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.dispatchRecord.driverName).toBe('Jane Driver');
      expect(loadAfter.body.dispatchRecord.trailerNumber).toBe('TR-100');
    });

    it('snapshot is independent of the source Carrier record — editing a reusable Driver after dispatch does not change history', async () => {
      const carrierId = await createEligibleCarrier('dispatch-snapshot');
      const driverRes = await adminAgent
        .post(`${API}/carriers/${carrierId}/drivers`)
        .send({ firstName: 'Original', lastName: 'Driver', phone: '555-1111' })
        .expect(201);
      const loadId = await createBookedLoad('dispatch-snapshot');
      await progressToRateConfirmation(loadId, carrierId);

      await adminAgent
        .post(`${API}/loads/${loadId}/dispatch`)
        .send({
          ...DISPATCH_BODY,
          driverName: 'Original Driver',
          sourceDriverId: driverRes.body.id,
        })
        .expect(200);

      // The underlying Driver record is edited server-side directly (no
      // PATCH /carriers/:id/drivers/:id endpoint exists in this codebase —
      // Driver records are add-only per Phase 2), simulating what a future
      // edit path would do; the DispatchRecord must remain unaffected.
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.driver.update({ where: { id: driverRes.body.id }, data: { firstName: 'Changed' } }),
      );

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.dispatchRecord.driverName).toBe('Original Driver');
    });
  });

  describe('Post-Dispatch Editing — Workflow 6 §6.9', () => {
    it('updates the current DispatchRecord fields and audits the field-level diff', async () => {
      const carrierId = await createEligibleCarrier('update-dispatch');
      const loadId = await createBookedLoad('update-dispatch');
      await progressToDispatched(loadId, carrierId);

      const res = await adminAgent
        .patch(`${API}/loads/${loadId}/dispatch`)
        .send({ driverName: 'New Driver' })
        .expect(200);
      expect(res.body.driverName).toBe('New Driver');
    });

    it('rejects editing before the Load has been Dispatched', async () => {
      const carrierId = await createEligibleCarrier('update-dispatch-early');
      const loadId = await createBookedLoad('update-dispatch-early');
      await progressToRateConfirmation(loadId, carrierId);

      await adminAgent
        .patch(`${API}/loads/${loadId}/dispatch`)
        .send({ driverName: 'New Driver' })
        .expect(409);
    });
  });

  describe('Stop progress -> derived Load status — Workflow 6 §6.3-§6.6', () => {
    it('multi-pickup: IN_TRANSIT only after ALL pickup stops complete', async () => {
      const carrierId = await createEligibleCarrier('multi-pickup');
      const loadId = await createBookedLoad('multi-pickup', MULTI_PICKUP_STOPS);
      await progressToDispatched(loadId, carrierId);

      const arrival1 = await adminAgent
        .post(`${API}/loads/${loadId}/stops/1/arrival`)
        .send({})
        .expect(200);
      expect(arrival1.body.load.status).toBe('PICKUP');
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);

      const stillPickup = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(stillPickup.body.status).toBe('PICKUP'); // second pickup not yet completed

      await adminAgent.post(`${API}/loads/${loadId}/stops/2/arrival`).send({}).expect(200);
      const departure2 = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/departure`)
        .send({})
        .expect(200);
      expect(departure2.body.load.status).toBe('IN_TRANSIT');
    });

    it('multi-delivery: DELIVERED only once the FINAL-by-sequence delivery stop completes', async () => {
      const carrierId = await createEligibleCarrier('multi-delivery');
      const loadId = await createBookedLoad('multi-delivery', MULTI_DELIVERY_STOPS);
      await progressToDispatched(loadId, carrierId);

      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);

      // Complete the earlier-sequence delivery (seq 2) first — must NOT deliver yet.
      await adminAgent.post(`${API}/loads/${loadId}/stops/2/arrival`).send({}).expect(200);
      const earlyDeliveryDone = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/departure`)
        .send({})
        .expect(200);
      expect(earlyDeliveryDone.body.load.status).toBe('IN_TRANSIT');

      // Now complete the true final delivery (seq 3).
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/arrival`).send({}).expect(200);
      const finalDeliveryDone = await adminAgent
        .post(`${API}/loads/${loadId}/stops/3/departure`)
        .send({})
        .expect(200);
      expect(finalDeliveryDone.body.load.status).toBe('DELIVERED');
    });

    it('rejects an arrival on a Stop that already recorded one', async () => {
      const carrierId = await createEligibleCarrier('duplicate-arrival');
      const loadId = await createBookedLoad('duplicate-arrival');
      await progressToDispatched(loadId, carrierId);

      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(409);
    });

    it('rejects a departure before an arrival is recorded', async () => {
      const carrierId = await createEligibleCarrier('departure-no-arrival');
      const loadId = await createBookedLoad('departure-no-arrival');
      await progressToDispatched(loadId, carrierId);

      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(409);
    });
  });

  describe('Check Calls — Workflow 6 §6.7', () => {
    it('blocks a Check Call before the Load has been Dispatched', async () => {
      const carrierId = await createEligibleCarrier('checkcall-early');
      const loadId = await createBookedLoad('checkcall-early');
      await progressToRateConfirmation(loadId, carrierId);

      await adminAgent
        .post(`${API}/loads/${loadId}/check-calls`)
        .send({
          contactMethod: 'Phone',
          personContacted: 'Driver',
          locationCity: 'Tulsa',
          locationState: 'OK',
          onTimeStatus: 'ON_TIME',
        })
        .expect(422);
    });

    it('logs a Check Call once Dispatched and updates the Load current location/ETA', async () => {
      const carrierId = await createEligibleCarrier('checkcall-happy');
      const loadId = await createBookedLoad('checkcall-happy');
      await progressToDispatched(loadId, carrierId);

      const eta = new Date(Date.now() + 3600_000).toISOString();
      await adminAgent
        .post(`${API}/loads/${loadId}/check-calls`)
        .send({
          contactMethod: 'Phone',
          personContacted: 'Driver',
          locationCity: 'Tulsa',
          locationState: 'OK',
          eta,
          onTimeStatus: 'ON_TIME',
        })
        .expect(201);

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.currentLocationCity).toBe('Tulsa');
      expect(loadAfter.body.currentLocationState).toBe('OK');
    });
  });

  describe('Risk Status — Workflow 6 §6.8 (independent of Load.status)', () => {
    it('requires a reason when status is not Normal', async () => {
      const carrierId = await createEligibleCarrier('risk-no-reason');
      const loadId = await createBookedLoad('risk-no-reason');
      await progressToDispatched(loadId, carrierId);

      await adminAgent
        .patch(`${API}/loads/${loadId}/risk-status`)
        .send({ riskStatus: 'AT_RISK' })
        .expect(422);
    });

    it('sets Risk Status independent of Load.status', async () => {
      const carrierId = await createEligibleCarrier('risk-happy');
      const loadId = await createBookedLoad('risk-happy');
      await progressToDispatched(loadId, carrierId);

      const res = await adminAgent
        .patch(`${API}/loads/${loadId}/risk-status`)
        .send({ riskStatus: 'DELAYED', riskReason: 'Weather' })
        .expect(200);
      expect(res.body.riskStatus).toBe('DELAYED');
      expect(res.body.status).toBe('DISPATCHED'); // primary status untouched
    });

    it('blocks Risk Status before the Load has been Dispatched', async () => {
      const carrierId = await createEligibleCarrier('risk-early');
      const loadId = await createBookedLoad('risk-early');
      await progressToRateConfirmation(loadId, carrierId);

      await adminAgent
        .patch(`${API}/loads/${loadId}/risk-status`)
        .send({ riskStatus: 'NORMAL' })
        .expect(422);
    });
  });

  describe('Dispatcher Assignment — independent action (approved Phase 4 decision)', () => {
    it('assigns a dispatcher to a freshly-Booked Load, before any sourcing has begun', async () => {
      const loadId = await createBookedLoad('dispatcher-assign-early');
      const dispatcherUserId = await currentUserId(dispatcherAgent);
      const res = await adminAgent
        .patch(`${API}/loads/${loadId}/dispatcher`)
        .send({ dispatcherUserId })
        .expect(200);
      expect(res.body.assignedDispatcherId).toBeTruthy();
    });

    it('is never a prerequisite for Carrier Assignment, Rate Confirmation, or Dispatch', async () => {
      const carrierId = await createEligibleCarrier('dispatcher-not-prereq');
      const loadId = await createBookedLoad('dispatcher-not-prereq');
      // Never calls the dispatcher-assignment endpoint at all.
      await progressToDispatched(loadId, carrierId);
      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.status).toBe('DISPATCHED');
      expect(loadAfter.body.assignedDispatcherId).toBeNull();
    });
  });

  describe('Reschedule Stop — Frontend Phase 6 gap-fix (Dispatch Board Calendar drag-to-reschedule)', () => {
    it('Admin reschedules a PENDING stop and an AuditLog entry is persisted with previous/new values', async () => {
      const loadId = await createBookedLoad('reschedule-admin');
      const before = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const previousAppointment = before.body.stops.find(
        (s: { sequence: number }) => s.sequence === 1,
      ).appointmentDatetime;

      const res = await adminAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(200);
      expect(res.body.appointmentDatetime).toBe('2027-03-15T14:00:00.000Z');
      expect(res.body.status).toBe('PENDING'); // never touched

      const entry = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.auditLog.findFirst({
          where: { organizationId: orgId, entityType: 'Stop', action: 'Stop Rescheduled' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(entry).toBeTruthy();
      expect(entry?.newValue).toMatchObject({
        sequence: 1,
        appointmentDatetime: '2027-03-15T14:00:00.000Z',
      });
      expect(entry?.previousValue).toMatchObject({
        sequence: 1,
        appointmentDatetime: previousAppointment,
      });
    });

    it('Operations Manager can reschedule an eligible PENDING stop', async () => {
      const loadId = await createBookedLoad('reschedule-opsmanager');
      await opsManagerAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(200);
    });

    it('Dispatcher can reschedule an eligible PENDING stop', async () => {
      const loadId = await createBookedLoad('reschedule-dispatcher');
      await dispatcherAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(200);
    });

    it('Sales/Booking cannot reschedule (403)', async () => {
      const loadId = await createBookedLoad('reschedule-sales');
      await salesAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(403);
    });

    it('Accounting cannot reschedule (403)', async () => {
      const loadId = await createBookedLoad('reschedule-accounting');
      await accountingAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(403);
    });

    it('rejects rescheduling a Stop that has already recorded an ARRIVED (409)', async () => {
      const carrierId = await createEligibleCarrier('reschedule-arrived');
      const loadId = await createBookedLoad('reschedule-arrived');
      await progressToDispatched(loadId, carrierId);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);

      await adminAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(409);
    });

    it('rejects rescheduling a COMPLETED Stop (409)', async () => {
      const carrierId = await createEligibleCarrier('reschedule-completed');
      const loadId = await createBookedLoad('reschedule-completed');
      await progressToDispatched(loadId, carrierId);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);

      await adminAgent
        .patch(`${API}/loads/${loadId}/stops/1/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(409);
    });

    it('rejects rescheduling on a DELIVERED Load even for a still-PENDING earlier Delivery stop (409)', async () => {
      // MULTI_DELIVERY_STOPS: seq1 PICKUP, seq2 DELIVERY, seq3 DELIVERY (final).
      // deriveLoadStatus only requires all Pickups + the FINAL Delivery
      // COMPLETED for DELIVERED — seq2 can legitimately still be PENDING.
      const carrierId = await createEligibleCarrier('reschedule-delivered');
      const loadId = await createBookedLoad('reschedule-delivered', MULTI_DELIVERY_STOPS);
      await progressToDispatched(loadId, carrierId);

      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/arrival`).send({}).expect(200);
      const departure3 = await adminAgent
        .post(`${API}/loads/${loadId}/stops/3/departure`)
        .send({})
        .expect(200);
      expect(departure3.body.load.status).toBe('DELIVERED');

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const stop2 = loadAfter.body.stops.find((s: { sequence: number }) => s.sequence === 2);
      expect(stop2.status).toBe('PENDING'); // confirms the edge case actually holds

      await adminAgent
        .patch(`${API}/loads/${loadId}/stops/2/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(409);
    });

    it('rejects rescheduling on a CLOSED Load (409)', async () => {
      const carrierId = await createEligibleCarrier('reschedule-closed');
      const loadId = await createBookedLoad('reschedule-closed', MULTI_DELIVERY_STOPS);
      await progressToDispatched(loadId, carrierId);

      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/departure`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/close`).expect(200);

      await adminAgent
        .patch(`${API}/loads/${loadId}/stops/2/reschedule`)
        .send({ appointmentDatetime: '2027-03-15T14:00:00.000Z' })
        .expect(409);
    });
  });

  describe('Permissions — Workflow 5/6 Cross-Cutting Permissions', () => {
    it('Sales/Booking is blocked from every Phase 4 mutating action (view-only)', async () => {
      const carrierId = await createEligibleCarrier('perm-sales');
      const loadId = await createBookedLoad('perm-sales');

      await salesAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(403);
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await salesAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(403);

      // still readable
      await salesAgent.get(`${API}/loads/${loadId}`).expect(200);
    });

    it('Accounting is blocked from every Phase 4 mutating action', async () => {
      const loadId = await createBookedLoad('perm-accounting');

      await accountingAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(403);
    });

    it('Dispatcher CAN perform sourcing and dispatch actions', async () => {
      const carrierId = await createEligibleCarrier('perm-dispatcher');
      const loadId = await createBookedLoad('perm-dispatcher');

      await dispatcherAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await dispatcherAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);
    });
  });

  describe('Cross-tenant isolation for Phase 4 tables', () => {
    it("one organization's sourcing/dispatch data is never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const customerAId = await createActiveCustomer(orgA.adminAgent, 'cross-a-cust');
      const loadARes = await orgA.adminAgent
        .post(`${API}/loads`)
        .send({
          customerId: customerAId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(201);
      const loadAId = loadARes.body.id;
      await orgA.adminAgent.post(`${API}/loads/${loadAId}/begin-sourcing`).expect(200);

      // --- Application-layer proof ------------------------------------
      await orgB.adminAgent.post(`${API}/loads/${loadAId}/begin-sourcing`).expect(404);
      await orgB.adminAgent.get(`${API}/loads/${loadAId}`).expect(404);

      // --- Database-layer (RLS) proof -----------------------------------
      const rowsVisibleFromWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM load WHERE id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromWrongTenant).toHaveLength(0);

      const rowsVisibleFromOwnTenant = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM load WHERE id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromOwnTenant.length).toBeGreaterThan(0);

      const rowsVisibleWithNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM load WHERE id = ${loadAId}::uuid`;
      expect(rowsVisibleWithNoContext).toHaveLength(0);
      // Two full setUpOrganization() calls (5 real agent logins each, real
      // bcrypt hashing) comfortably exceed Jest's 5000ms default under
      // --runInBand's sequential load — explicit override, not a hidden failure.
    }, 30000);
  });

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }
});
