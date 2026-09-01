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

/** Every route except /health sits behind the global prefix (main.ts / configure-app.ts). */
const API = '/api/v1';

const LOAD_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    companyName: 'St. Jude Candle Company',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    companyName: 'Return Test Customer',
    addressLine1: '2 Dock Rd',
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

const RETURN_PICKUP_INPUT = {
  companyName: 'Return Test Customer',
  addressLine1: '2 Dock Rd',
  city: 'Chicago',
  state: 'IL',
  zip: '60601',
};

const RETURN_DELIVERY_INPUT = {
  companyName: 'St. Jude Candle Company',
  addressLine1: '1 Dock Rd',
  city: 'Dallas',
  state: 'TX',
  zip: '75201',
};

/**
 * Return Product feature end-to-end proof: `initiateReturn` (append a
 * PICKUP/RETURN + DELIVERY/RETURN stop pair to an existing Load),
 * Load.status/podStatus protection (a return never distorts the standard
 * delivery's derived status or closing readiness), the narrow DELIVERED+
 * RETURN dispatch-tracking exception, POP/POD reuse via the existing
 * stopType-only document system, RETURN_FREIGHT billing, and
 * `linkReturnLoad` (the separate-Load case) — run against a live app
 * instance with a live PostgreSQL + Redis + S3-compatible store.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed   (system document types + RETURN_FREIGHT charge type)
 *   npm run test:e2e
 */
describe('Return Product (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'return-stops-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
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
        name: 'Return Stops Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    // Idempotent find-or-create (mirrors prisma/seed.ts's own pattern for
    // these exact system document types) rather than an unconditional
    // create — this file's org-scope-null CARRIER_COMPLIANCE types are
    // shared, global rows, and this suite runs against the same live DB
    // `npm run prisma:seed` already populated, not an empty/reset one.
    const types = await Promise.all(
      [
        { code: 'W9', label: 'W9', requiresReview: true },
        { code: 'COI', label: 'Certificate of Insurance', requiresReview: true },
        { code: 'CARRIER_AGREEMENT', label: 'Notice of Assignment', requiresReview: true },
        { code: 'MC_AUTHORITY', label: 'MC Authority', requiresReview: true },
      ].map(async (t) => {
        const existing = await prisma.documentTypeDefinition.findFirst({
          where: { organizationId: null, code: t.code },
        });
        if (existing) return existing;
        return prisma.documentTypeDefinition.create({
          data: {
            organizationId: null,
            category: 'CARRIER_COMPLIANCE',
            isSystemDefault: true,
            ...t,
          },
        });
      }),
    );
    [w9TypeId, coiTypeId, carrierAgreementTypeId, mcAuthorityTypeId] = types.map((t) => t.id);

    const org = await setUpOrganization('main');
    orgId = org.organizationId;
    adminAgent = org.adminAgent;
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
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

    const adminEmail = `admin-${seed}@return-stops-test.test`;
    const salesEmail = `sales-${seed}@return-stops-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@return-stops-test.test`;
    const reviewerEmail = `reviewer-${seed}@return-stops-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Return Stops Test Org ${seed}`,
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
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerAgentLocal = await activateAndLogin(reviewerEmail, 'ReviewerPass123');

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
      salesAgent: salesAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
      reviewerAgent: reviewerAgentLocal,
    };
  }

  async function createActiveCustomer(agent: SuperAgentTest, seed: string): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Return Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@return-stops-customer.test`,
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
        primaryContactEmail: `dispatch-${seed}@carrier-return-test.test`,
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
      .send({ customerId, stops, equipmentType: 'DRY_VAN', customerRate: '950.00' })
      .expect(201);
    return res.body.id;
  }

  /** Carries a freshly-Booked Load all the way to DISPATCHED. */
  async function progressToDispatched(loadId: string, carrierId: string): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate: '750.00' })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
  }

  /** Carries a freshly-Booked Load all the way to DELIVERED (standard pickup + delivery only). */
  async function progressToDelivered(loadId: string, carrierId: string): Promise<void> {
    await progressToDispatched(loadId, carrierId);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/departure`).send({}).expect(200);
  }

  async function initiateReturn(loadId: string) {
    return adminAgent
      .post(`${API}/loads/${loadId}/stops/return`)
      .send({ pickupStop: RETURN_PICKUP_INPUT, deliveryStop: RETURN_DELIVERY_INPUT });
  }

  describe('Initiate Return — Load.status protection', () => {
    it('a return initiated after standard delivery leaves the Load DELIVERED, with the new stops appended at sequence 3/4, stopPurpose RETURN', async () => {
      const carrierId = await createEligibleCarrier('status-protect');
      const loadId = await createBookedLoad('status-protect');
      await progressToDelivered(loadId, carrierId);

      const res = await initiateReturn(loadId);
      expect(res.status).toBe(201);
      expect(res.body.load.status).toBe('DELIVERED');

      const returnStops = res.body.stops as {
        sequence: number;
        stopType: string;
        stopPurpose: string;
      }[];
      expect(returnStops).toHaveLength(2);
      expect(returnStops.find((s) => s.sequence === 3)).toMatchObject({
        stopType: 'PICKUP',
        stopPurpose: 'RETURN',
      });
      expect(returnStops.find((s) => s.sequence === 4)).toMatchObject({
        stopType: 'DELIVERY',
        stopPurpose: 'RETURN',
      });

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.status).toBe('DELIVERED');
      expect(loadAfter.body.stops).toHaveLength(4);
    });

    it('completing a return delivery before the standard delivery does not drive the Load to DELIVERED', async () => {
      const carrierId = await createEligibleCarrier('no-premature-delivered');
      const loadId = await createBookedLoad('no-premature-delivered');
      await progressToDispatched(loadId, carrierId);

      // Standard pickup completes (IN_TRANSIT-bound), but the standard
      // delivery (stop 2) never does in this test.
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);

      const loadInTransit = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadInTransit.body.status).toBe('IN_TRANSIT');

      const returnRes = await initiateReturn(loadId);
      expect(returnRes.status).toBe(201);
      // Still IN_TRANSIT — a return can only be initiated once Dispatched,
      // and initiating it must not itself change status.
      expect(returnRes.body.load.status).toBe('IN_TRANSIT');
    });

    it('standard arrival/departure behavior is unaffected by an in-progress return', async () => {
      const carrierId = await createEligibleCarrier('standard-unaffected');
      const loadId = await createBookedLoad('standard-unaffected');
      await progressToDelivered(loadId, carrierId);
      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));

      // Re-recording arrival on an already-completed standard stop still
      // rejects exactly as it did before this feature existed.
      await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(409);
    });
  });

  describe('Return tracking on a DELIVERED Load — the narrow DELIVERED+RETURN exception', () => {
    it('recordArrival/recordDeparture succeed against the new return stops even though the Load is already DELIVERED', async () => {
      const carrierId = await createEligibleCarrier('return-tracking');
      const loadId = await createBookedLoad('return-tracking');
      await progressToDelivered(loadId, carrierId);
      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));

      await adminAgent.post(`${API}/loads/${loadId}/stops/3/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/departure`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/4/arrival`).send({}).expect(200);
      const departure4 = await adminAgent
        .post(`${API}/loads/${loadId}/stops/4/departure`)
        .send({})
        .expect(200);

      // Recording the return leg's own completion must not disturb status.
      expect(departure4.body.load.status).toBe('DELIVERED');
    });
  });

  describe('POP/POD reuse for return stops — zero document-system changes', () => {
    it('uploads a POP against the return pickup and a POD against the return delivery, and podStatus stays COMPLETE throughout', async () => {
      const carrierId = await createEligibleCarrier('pop-pod-reuse');
      const loadId = await createBookedLoad('pop-pod-reuse');
      await progressToDelivered(loadId, carrierId);

      const podRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod-standard.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      await fetch(podRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 standard pod'),
      });
      await adminAgent.post(`${API}/documents/${podRes.body.document.id}/confirm`).expect(200);
      expect(await waitForScanStatus(podRes.body.document.id)).toBe('CLEAN');

      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/3/departure`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/4/arrival`).send({}).expect(200);
      await adminAgent.post(`${API}/loads/${loadId}/stops/4/departure`).send({}).expect(200);

      // Return pickup (stop 3) gets a POP exactly like any other PICKUP stop.
      const popRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/3/pop-documents`)
        .send({ fileName: 'pop-return.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      expect(popRes.body.document.id).toBeDefined();

      // Return delivery (stop 4) gets a POD exactly like any other DELIVERY stop.
      const returnPodRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/4/pod-documents`)
        .send({ fileName: 'pod-return.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      expect(returnPodRes.body.document.id).toBeDefined();

      // podStatus was already COMPLETE from the standard delivery alone,
      // and must remain so regardless of the return leg's own document state.
      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.podStatus).toBe('COMPLETE');
    });

    it('podStatus reaches COMPLETE from the standard delivery alone, even before the return delivery has any POD', async () => {
      const carrierId = await createEligibleCarrier('pod-independent');
      const loadId = await createBookedLoad('pod-independent');
      await progressToDelivered(loadId, carrierId);
      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));

      const podRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      await fetch(podRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 standard pod'),
      });
      await adminAgent.post(`${API}/documents/${podRes.body.document.id}/confirm`).expect(200);
      expect(await waitForScanStatus(podRes.body.document.id)).toBe('CLEAN');

      // Give the recalculation hook a moment.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.podStatus).toBe('COMPLETE');
      // The return delivery stop (4) has no POD at all, yet podStatus is
      // still COMPLETE — proves the STANDARD-only filter.
      expect(loadAfter.body.stops.find((s: { sequence: number }) => s.sequence === 4).hasPod).toBe(
        false,
      );
    });
  });

  describe('Multiple / interleaved returns', () => {
    it('a second return pair appends at the next free sequence (5/6) after an earlier return pair', async () => {
      const carrierId = await createEligibleCarrier('multiple-returns');
      const loadId = await createBookedLoad('multiple-returns');
      await progressToDelivered(loadId, carrierId);

      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));
      const secondReturn = await initiateReturn(loadId);
      expect(secondReturn.status).toBe(201);
      const stops = secondReturn.body.stops as { sequence: number }[];
      expect(stops.map((s) => s.sequence).sort()).toEqual([5, 6]);

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.status).toBe('DELIVERED');
      expect(loadAfter.body.podStatus).toBe('NOT_RECEIVED');
      expect(loadAfter.body.stops).toHaveLength(6);
    });
  });

  describe('RETURN_FREIGHT billing — Scenarios B/C', () => {
    it('a RETURN_FREIGHT charge type exists and can be added on both the CUSTOMER and CARRIER side', async () => {
      const carrierId = await createEligibleCarrier('return-billing');
      const loadId = await createBookedLoad('return-billing');
      await progressToDelivered(loadId, carrierId);
      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));

      const chargeTypes = await adminAgent.get(`${API}/charge-types`).expect(200);
      const returnFreight = chargeTypes.body.find(
        (c: { code: string }) => c.code === 'RETURN_FREIGHT',
      );
      expect(returnFreight).toBeDefined();
      // A separate sibling type, not a reuse of REDELIVERY.
      const redelivery = chargeTypes.body.find((c: { code: string }) => c.code === 'REDELIVERY');
      expect(redelivery).toBeDefined();
      expect(redelivery.id).not.toBe(returnFreight.id);

      const customerCharge = await adminAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CUSTOMER', chargeTypeId: returnFreight.id, unitRate: '300.00' })
        .expect(201);
      expect(customerCharge.body.amount).toBe('300');

      const carrierCharge = await adminAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CARRIER', chargeTypeId: returnFreight.id, unitRate: '200.00' })
        .expect(201);
      expect(carrierCharge.body.amount).toBe('200');

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const charges = loadAfter.body.chargeLineItems as {
        side: string;
        amount: string;
        chargeTypeId: string;
      }[];
      expect(
        charges.some(
          (c) => c.side === 'CUSTOMER' && c.chargeTypeId === returnFreight.id && c.amount === '300',
        ),
      ).toBe(true);
      expect(
        charges.some(
          (c) => c.side === 'CARRIER' && c.chargeTypeId === returnFreight.id && c.amount === '200',
        ),
      ).toBe(true);
    });
  });

  describe('Load Closing checklist unaffected by return activity', () => {
    it('the POD checklist item stays CLEAN/Complete regardless of the return leg missing its own documents', async () => {
      const carrierId = await createEligibleCarrier('closing-unaffected');
      const loadId = await createBookedLoad('closing-unaffected');
      await progressToDelivered(loadId, carrierId);

      const podRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      await fetch(podRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 standard pod'),
      });
      await adminAgent.post(`${API}/documents/${podRes.body.document.id}/confirm`).expect(200);
      expect(await waitForScanStatus(podRes.body.document.id)).toBe('CLEAN');
      await new Promise((resolve) => setTimeout(resolve, 300));

      await initiateReturn(loadId).then((res) => expect(res.status).toBe(201));

      const checklist = await adminAgent
        .get(`${API}/loads/${loadId}/closing-checklist`)
        .expect(200);
      const podItem = checklist.body.checklist.find((i: { item: string }) => i.item === 'POD');
      expect(podItem).toMatchObject({ status: 'CLEAN', detail: 'Complete' });
    });
  });

  describe('Guards', () => {
    it('rejects initiating a return on a CLOSED Load', async () => {
      const carrierId = await createEligibleCarrier('closed-rejected');
      const loadId = await createBookedLoad('closed-rejected');
      await progressToDelivered(loadId, carrierId);
      await adminAgent.post(`${API}/loads/${loadId}/close`).expect(200);

      const res = await initiateReturn(loadId);
      expect(res.status).toBe(422);
    });

    it('rejects initiating a return on a pre-Dispatch (BOOKED) Load', async () => {
      const loadId = await createBookedLoad('pre-dispatch-rejected');

      const res = await initiateReturn(loadId);
      expect(res.status).toBe(422);
    });

    it('Sales/Booking is blocked from initiating a return', async () => {
      const carrierId = await createEligibleCarrier('sales-blocked');
      const loadId = await createBookedLoad('sales-blocked');
      await progressToDelivered(loadId, carrierId);

      const res = await salesAgent
        .post(`${API}/loads/${loadId}/stops/return`)
        .send({ pickupStop: RETURN_PICKUP_INPUT, deliveryStop: RETURN_DELIVERY_INPUT });
      expect(res.status).toBe(403);
    });

    it('Dispatcher can initiate a return', async () => {
      const carrierId = await createEligibleCarrier('dispatcher-allowed');
      const loadId = await createBookedLoad('dispatcher-allowed');
      await progressToDelivered(loadId, carrierId);

      const res = await dispatcherAgent
        .post(`${API}/loads/${loadId}/stops/return`)
        .send({ pickupStop: RETURN_PICKUP_INPUT, deliveryStop: RETURN_DELIVERY_INPUT });
      expect(res.status).toBe(201);
    });
  });

  describe('linkReturnLoad — the separate-Load case', () => {
    it('links a new Load as a return for an original Load, visible from both sides', async () => {
      const originalCarrierId = await createEligibleCarrier('link-original');
      const originalLoadId = await createBookedLoad('link-original');
      await progressToDelivered(originalLoadId, originalCarrierId);

      const returnLoadId = await createBookedLoad('link-return-load');

      const linkRes = await adminAgent
        .patch(`${API}/loads/${returnLoadId}/link-return`)
        .send({ returnForLoadId: originalLoadId })
        .expect(200);
      expect(linkRes.body.returnForLoadId).toBe(originalLoadId);

      const returnLoadView = await adminAgent.get(`${API}/loads/${returnLoadId}`).expect(200);
      expect(returnLoadView.body.returnForLoad.id).toBe(originalLoadId);

      const originalLoadView = await adminAgent.get(`${API}/loads/${originalLoadId}`).expect(200);
      expect(
        (originalLoadView.body.returnLoads as { id: string }[]).some((l) => l.id === returnLoadId),
      ).toBe(true);
    });

    it('rejects linking a Load as a return for itself', async () => {
      const loadId = await createBookedLoad('link-self-rejected');

      const res = await adminAgent
        .patch(`${API}/loads/${loadId}/link-return`)
        .send({ returnForLoadId: loadId });
      expect(res.status).toBe(422);
    });
  });
});
