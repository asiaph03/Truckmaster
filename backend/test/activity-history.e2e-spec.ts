import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { MALWARE_SCANNER } from '../src/common/malware-scan/malware-scanner.interface';

import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

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

/**
 * Frontend Phase 7 (Load Detail Activity History, UI_UX_DESIGN.md §5.4.4,
 * Decision LD-6) end-to-end proof: Internal Note / Communication Activity
 * create endpoints, the unified read endpoint, its financial redaction
 * (mirroring financials.e2e-spec.ts's "Financial data exposure
 * remediation" pattern), and cross-tenant isolation for the two new
 * tables (mirroring financials.e2e-spec.ts's "Cross-tenant isolation"
 * pattern).
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Activity History (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'activity-history-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let opsManagerAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let mainOrgId: string;

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
        name: 'Activity History Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const types = await Promise.all(
      [
        { code: 'W9', label: 'W9', requiresReview: true },
        { code: 'COI', label: 'Certificate of Insurance', requiresReview: true },
        { code: 'CARRIER_AGREEMENT', label: 'Notice of Assignment', requiresReview: true },
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
    mainOrgId = org.organizationId;
    adminAgent = org.adminAgent;
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
    accountingAgent = org.accountingAgent;
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
    await (
      await withCsrf(request.agent(app.getHttpServer()))
    )
      .post(`${API}/auth/activate`)
      .send({ token, password })
      .expect(200);
    const agent = await withCsrf(request.agent(app.getHttpServer()));
    await agent.post(`${API}/auth/login`).send({ email, password }).expect(200);
    return agent;
  }

  async function setUpOrganization(seed: string) {
    const superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@activity-history-test.test`;
    const salesEmail = `sales-${seed}@activity-history-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@activity-history-test.test`;
    const accountingEmail = `accounting-${seed}@activity-history-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@activity-history-test.test`;
    const reviewerEmail = `reviewer-${seed}@activity-history-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Activity History Test Org ${seed}`,
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
      salesAgent: salesAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
      accountingAgent: accountingAgentLocal,
      opsManagerAgent: opsManagerAgentLocal,
      reviewerAgent: reviewerAgentLocal,
    };
  }

  async function createActiveCustomer(agent: SuperAgentTest, seed: string): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Activity History Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@activity-history-customer.test`,
        primaryContactPhone: '555-0200',
        paymentTermsOverride: 'NET_30',
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

  async function waitForScanStatus(
    documentId: string,
    orgId: string,
    timeoutMs = 10_000,
  ): Promise<string> {
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
      expect(await waitForScanStatus(id, mainOrgId)).toBe('CLEAN');
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

  async function createBookedLoad(
    agent: SuperAgentTest,
    seed: string,
    customerId: string,
    customerRate = '1800.00',
  ): Promise<string> {
    const res = await agent
      .post(`${API}/loads`)
      .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate })
      .expect(201);
    return res.body.id;
  }

  // ---------------------------------------------------------------------

  describe('POST /loads/:id/internal-notes', () => {
    it('creates a note and it appears in the activity history', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'note-happy');
      const loadId = await createBookedLoad(adminAgent, 'note-happy', customerId);

      await adminAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: 'Customer asked for a rate re-check.' })
        .expect(201);

      const history = await adminAgent.get(`${API}/loads/${loadId}/activity-history`).expect(200);
      const note = history.body.find((e: { type: string }) => e.type === 'NOTE');
      expect(note.content).toBe('Customer asked for a rate re-check.');
      expect(note.authorUserId).toBeDefined();
    });

    it('rejects empty content with 400', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'note-empty');
      const loadId = await createBookedLoad(adminAgent, 'note-empty', customerId);
      await adminAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: '' })
        .expect(400);
    });

    it('blocks Compliance Reviewer (not an operational Load role)', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'note-reviewer-blocked');
      const loadId = await createBookedLoad(adminAgent, 'note-reviewer-blocked', customerId);
      await reviewerAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: 'x' })
        .expect(403);
    });

    it('allows Sales/Booking and Accounting to add a note', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'note-broad-roles');
      const loadId = await createBookedLoad(adminAgent, 'note-broad-roles', customerId);
      await salesAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: 'x' })
        .expect(201);
      await accountingAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: 'y' })
        .expect(201);
    });
  });

  describe('POST /loads/:id/communication-activities', () => {
    it('creates a communication activity with free-text activityType and optional direction', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'comm-happy');
      const loadId = await createBookedLoad(adminAgent, 'comm-happy', customerId);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({ activityType: 'Called Carrier', notes: 'Confirmed pickup appointment.' })
        .expect(201);
      expect(res.body.activityType).toBe('Called Carrier');
      expect(res.body.direction).toBeNull();
    });

    it('accepts an explicit direction and contactPerson', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'comm-direction');
      const loadId = await createBookedLoad(adminAgent, 'comm-direction', customerId);

      const res = await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({
          activityType: 'Sent Rate Confirmation',
          direction: 'OUTBOUND',
          contactPerson: 'Jane at Shipper Co',
          notes: 'Emailed rate confirmation for signature.',
        })
        .expect(201);
      expect(res.body.direction).toBe('OUTBOUND');
      expect(res.body.contactPerson).toBe('Jane at Shipper Co');
    });

    it('rejects an invalid direction value with 400', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'comm-bad-direction');
      const loadId = await createBookedLoad(adminAgent, 'comm-bad-direction', customerId);
      await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({ activityType: 'Called Carrier', direction: 'SIDEWAYS', notes: 'x' })
        .expect(400);
    });

    it('defaults occurredAt to now when omitted, and respects an explicit value', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'comm-occurred-at');
      const loadId = await createBookedLoad(adminAgent, 'comm-occurred-at', customerId);

      const before = Date.now();
      const defaulted = await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({ activityType: 'Called Carrier', notes: 'x' })
        .expect(201);
      const occurredAtMs = new Date(defaulted.body.occurredAt).getTime();
      expect(occurredAtMs).toBeGreaterThanOrEqual(before - 1000);
      expect(occurredAtMs).toBeLessThanOrEqual(Date.now() + 1000);

      const explicit = await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({
          activityType: 'Called Carrier',
          notes: 'x',
          occurredAt: '2026-01-01T00:00:00.000Z',
        })
        .expect(201);
      expect(explicit.body.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('blocks Compliance Reviewer', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'comm-reviewer-blocked');
      const loadId = await createBookedLoad(adminAgent, 'comm-reviewer-blocked', customerId);
      await reviewerAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({ activityType: 'x', notes: 'x' })
        .expect(403);
    });
  });

  describe('GET /loads/:id/activity-history', () => {
    it('is visible to every membership role (view is unrestricted, per the locked "visible to all roles" rule)', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'view-all-roles');
      const loadId = await createBookedLoad(adminAgent, 'view-all-roles', customerId);

      for (const agent of [
        adminAgent,
        opsManagerAgent,
        dispatcherAgent,
        salesAgent,
        accountingAgent,
        reviewerAgent,
      ]) {
        await agent.get(`${API}/loads/${loadId}/activity-history`).expect(200);
      }
    });

    it('merges Notes, Communications, and Audit entries into one reverse-chronological timeline', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'merge-timeline');
      const loadId = await createBookedLoad(adminAgent, 'merge-timeline', customerId);
      // The booking itself already wrote a 'Load Booked Directly (No Quote)' AuditLog entry.

      await adminAgent
        .post(`${API}/loads/${loadId}/internal-notes`)
        .send({ content: 'A note.' })
        .expect(201);
      await adminAgent
        .post(`${API}/loads/${loadId}/communication-activities`)
        .send({ activityType: 'Called Carrier', notes: 'A call.' })
        .expect(201);

      const history = await adminAgent.get(`${API}/loads/${loadId}/activity-history`).expect(200);
      const types = history.body.map((e: { type: string }) => e.type);
      expect(types).toEqual(expect.arrayContaining(['AUDIT', 'NOTE', 'COMMUNICATION']));

      // Reverse-chronological: every entry's timestamp is >= the next entry's.
      const timestamps = history.body.map((e: { timestamp: string }) =>
        new Date(e.timestamp).getTime(),
      );
      for (let i = 0; i < timestamps.length - 1; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
      }
    });
  });

  describe('Financial redaction in Activity History — LD-6', () => {
    it('redacts carrierRate on the Carrier Assigned audit entry per the 5 required role/ownership scenarios', async () => {
      const carrierId = await createEligibleCarrier('ldr-carrier-rate');
      const ownCustomerId = await createActiveCustomer(salesAgent, 'ldr-carrier-rate-own');
      const loadId = await createBookedLoad(
        salesAgent,
        'ldr-carrier-rate',
        ownCustomerId,
        '2200.00',
      );

      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1700.00' })
        .expect(200);

      async function carrierRateFor(agent: SuperAgentTest): Promise<unknown> {
        const res = await agent.get(`${API}/loads/${loadId}/activity-history`).expect(200);
        const entry = res.body.find(
          (e: { type: string; action?: string }) =>
            e.type === 'AUDIT' && e.action === 'Carrier Assigned',
        );
        return entry.newValue.carrierRate;
      }

      expect(await carrierRateFor(adminAgent)).not.toBeNull();
      expect(await carrierRateFor(opsManagerAgent)).not.toBeNull();
      expect(await carrierRateFor(dispatcherAgent)).toBeNull();
      // Owning Sales/Booking (created this Load) — carrier-side still redacted regardless of ownership.
      expect(await carrierRateFor(salesAgent)).toBeNull();

      // Non-owning Sales/Booking: a second Sales/Booking agent in the same org, on a Load they did not create.
      const orgForNonOwning = await setUpOrganization('ldr-non-owning');
      const nonOwningCustomerId = await createActiveCustomer(
        orgForNonOwning.adminAgent,
        'ldr-non-owning',
      );
      const nonOwningLoadId = await createBookedLoad(
        orgForNonOwning.adminAgent,
        'ldr-non-owning',
        nonOwningCustomerId,
        '2200.00',
      );
      const nonOwningCarrierId = await createEligibleCarrierFor(orgForNonOwning, 'ldr-non-owning');
      await orgForNonOwning.adminAgent
        .post(`${API}/loads/${nonOwningLoadId}/begin-sourcing`)
        .expect(200);
      await orgForNonOwning.adminAgent
        .post(`${API}/loads/${nonOwningLoadId}/assign-carrier`)
        .send({ carrierId: nonOwningCarrierId, carrierRate: '1700.00' })
        .expect(200);
      const nonOwningView = await orgForNonOwning.salesAgent
        .get(`${API}/loads/${nonOwningLoadId}/activity-history`)
        .expect(200);
      const nonOwningEntry = nonOwningView.body.find(
        (e: { type: string; action?: string }) =>
          e.type === 'AUDIT' && e.action === 'Carrier Assigned',
      );
      expect(nonOwningEntry.newValue.carrierRate).toBeNull();
    }, 30000);

    async function createEligibleCarrierFor(
      org: { adminAgent: SuperAgentTest; reviewerAgent: SuperAgentTest; organizationId: string },
      seed: string,
    ): Promise<string> {
      const res = await org.adminAgent
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
      const w9Id = await uploadAndConfirm(org.adminAgent, carrierId, w9TypeId, 'w9.pdf');
      const caId = await uploadAndConfirm(
        org.adminAgent,
        carrierId,
        carrierAgreementTypeId,
        'agreement.pdf',
      );
      const mcId = await uploadAndConfirm(
        org.adminAgent,
        carrierId,
        mcAuthorityTypeId,
        'mc-authority.pdf',
      );
      const coiId = await uploadAndConfirm(org.adminAgent, carrierId, coiTypeId, 'coi.pdf');
      for (const id of [w9Id, caId, mcId, coiId]) {
        expect(await waitForScanStatus(id, org.organizationId)).toBe('CLEAN');
      }
      for (const id of [w9Id, caId, mcId, coiId]) {
        await org.reviewerAgent
          .post(`${API}/carriers/${carrierId}/documents/${id}/review`)
          .send({ decision: 'APPROVED' })
          .expect(200);
      }
      for (const coverageType of ['AUTO_LIABILITY', 'CARGO']) {
        await org.adminAgent
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
      await org.reviewerAgent
        .post(`${API}/carriers/${carrierId}/fmcsa-verification`)
        .send({ verificationDate: '2026-01-01', resultStatus: 'Authorized' })
        .expect(201);
      await org.reviewerAgent.post(`${API}/carriers/${carrierId}/activate`).expect(200);
      return carrierId;
    }

    it('redacts chargeLineItem amount per-side on the Charge Line Item Added audit entry', async () => {
      const carrierId = await createEligibleCarrier('ldr-charge');
      const customerId = await createActiveCustomer(adminAgent, 'ldr-charge');
      const loadId = await createBookedLoad(adminAgent, 'ldr-charge', customerId, '2000.00');
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);
      const chargeTypes = await adminAgent.get(`${API}/charge-types`).expect(200);
      const detentionTypeId = chargeTypes.body.find(
        (c: { code: string }) => c.code === 'DETENTION',
      ).id;

      await adminAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CUSTOMER', chargeTypeId: detentionTypeId, unitRate: '250.00' })
        .expect(201);
      await adminAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CARRIER', chargeTypeId: detentionTypeId, unitRate: '150.00' })
        .expect(201);

      const dispatcherView = await dispatcherAgent
        .get(`${API}/loads/${loadId}/activity-history`)
        .expect(200);
      const dispatcherCharges = dispatcherView.body.filter(
        (e: { type: string; action?: string }) =>
          e.type === 'AUDIT' && e.action === 'Charge Line Item Added',
      );
      expect(
        dispatcherCharges.every(
          (e: { newValue: { amount: unknown } }) => e.newValue.amount === null,
        ),
      ).toBe(true);

      const adminView = await adminAgent.get(`${API}/loads/${loadId}/activity-history`).expect(200);
      const adminCharges = adminView.body.filter(
        (e: { type: string; action?: string }) =>
          e.type === 'AUDIT' && e.action === 'Charge Line Item Added',
      );
      expect(
        adminCharges.every((e: { newValue: { amount: unknown } }) => e.newValue.amount !== null),
      ).toBe(true);
    }, 20000);
  });

  describe('Cross-tenant isolation for Phase 7 tables', () => {
    it("one organization's Internal Notes / Communication Activities are never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const customerAId = await createActiveCustomer(orgA.adminAgent, 'cross-a-cust');
      const loadAId = await createBookedLoad(orgA.adminAgent, 'cross-a', customerAId);

      await orgA.adminAgent
        .post(`${API}/loads/${loadAId}/internal-notes`)
        .send({ content: 'Org A private note.' })
        .expect(201);
      await orgA.adminAgent
        .post(`${API}/loads/${loadAId}/communication-activities`)
        .send({ activityType: 'Called Carrier', notes: 'Org A private call.' })
        .expect(201);

      // --- Application-layer proof: org B cannot even see this Load exists -----
      await orgB.adminAgent.get(`${API}/loads/${loadAId}/activity-history`).expect(404);
      await orgB.adminAgent
        .post(`${API}/loads/${loadAId}/internal-notes`)
        .send({ content: 'x' })
        .expect(404);

      // --- Database-layer (RLS) proof for both new tables -----
      const noteRowsWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM internal_note WHERE load_id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(noteRowsWrongTenant).toHaveLength(0);

      const commRowsWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM communication_activity WHERE load_id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(commRowsWrongTenant).toHaveLength(0);

      const noteRowsOwnTenant = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM internal_note WHERE load_id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(noteRowsOwnTenant.length).toBeGreaterThan(0);

      const noteRowsNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM internal_note WHERE load_id = ${loadAId}::uuid`;
      expect(noteRowsNoContext).toHaveLength(0);

      const commRowsNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM communication_activity WHERE load_id = ${loadAId}::uuid`;
      expect(commRowsNoContext).toHaveLength(0);
    }, 30000);
  });
});
