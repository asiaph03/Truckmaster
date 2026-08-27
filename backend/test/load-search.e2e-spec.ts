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

const API = '/api/v1';

const DALLAS_CHICAGO_STOPS = [
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

const HOUSTON_ATLANTA_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    addressLine1: '10 Port Rd',
    city: 'Houston',
    state: 'TX',
    zip: '77001',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    addressLine1: '20 Peach St',
    city: 'Atlanta',
    state: 'GA',
    zip: '30301',
  },
];

const EARLY_STOPS = [
  {
    ...DALLAS_CHICAGO_STOPS[0],
    appointmentDatetime: '2026-01-05T08:00:00.000Z',
  },
  {
    ...DALLAS_CHICAGO_STOPS[1],
    appointmentDatetime: '2026-01-08T08:00:00.000Z',
  },
];

const LATE_STOPS = [
  {
    ...DALLAS_CHICAGO_STOPS[0],
    appointmentDatetime: '2026-03-20T08:00:00.000Z',
  },
  {
    ...DALLAS_CHICAGO_STOPS[1],
    appointmentDatetime: '2026-03-25T08:00:00.000Z',
  },
];

const DISPATCH_BODY = {
  driverName: 'Jane Driver',
  driverPhone: '555-9000',
  truckNumber: 'T-100',
  trailerNumber: 'TR-100',
};

/**
 * Frontend Phase 13 (Load Search) end-to-end proof: `GET /loads/search`
 * and `GET /loads/search/export` — every locked filter, the free-text
 * search across all 4 locked fields, sorting (including the
 * sequence-based Pickup/Delivery Date fidelity requirement), pagination,
 * "all loads including Closed" by default, financial redaction reuse, CSV
 * export, and cross-tenant isolation.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Load Search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'load-search-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let orgId: string;

  let w9TypeId: string;
  let coiTypeId: string;
  let carrierAgreementTypeId: string;
  let mcAuthorityTypeId: string;

  let carrierId: string;
  let alphaCustomerId: string;
  let betaCustomerId: string;
  let loadAlphaId: string; // Dallas -> Chicago, DRY_VAN, no carrier
  let loadBetaId: string; // Houston -> Atlanta, REEFER, no carrier
  let loadWithCarrierId: string; // admin-owned, carrier assigned, AT_RISK
  let loadOwnedBySalesId: string; // sales-owned, same carrier assigned
  let loadClosedId: string;
  let loadEarlyId: string;
  let loadLateId: string;

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
        name: 'Load Search Suite Platform Super Admin',
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
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
    accountingAgent = org.accountingAgent;
    reviewerAgent = org.reviewerAgent;

    alphaCustomerId = await createActiveCustomer(adminAgent, 'alpha');
    betaCustomerId = await createActiveCustomer(adminAgent, 'beta');
    carrierId = await createEligibleCarrier('main');

    loadAlphaId = await createLoad(
      adminAgent,
      alphaCustomerId,
      DALLAS_CHICAGO_STOPS,
      'DRY_VAN',
      '1800.00',
    );
    loadBetaId = await createLoad(
      adminAgent,
      betaCustomerId,
      HOUSTON_ATLANTA_STOPS,
      'REEFER',
      '900.00',
    );

    loadWithCarrierId = await createLoad(
      adminAgent,
      alphaCustomerId,
      DALLAS_CHICAGO_STOPS,
      'DRY_VAN',
      '2000.00',
    );
    await adminAgent.post(`${API}/loads/${loadWithCarrierId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadWithCarrierId}/assign-carrier`)
      .send({ carrierId, carrierRate: '1500.00' })
      .expect(200);
    // Risk Status can only be set once a Load is Dispatched (see
    // dispatch-tracking.service.ts's POST_DISPATCH_STATUSES gate).
    await adminAgent
      .post(`${API}/loads/${loadWithCarrierId}/generate-rate-confirmation`)
      .send({})
      .expect(200);
    await adminAgent
      .post(`${API}/loads/${loadWithCarrierId}/dispatch`)
      .send(DISPATCH_BODY)
      .expect(200);
    await adminAgent
      .patch(`${API}/loads/${loadWithCarrierId}/risk-status`)
      .send({ riskStatus: 'AT_RISK', riskReason: 'Weather delay' })
      .expect(200);

    const ownRes = await salesAgent
      .post(`${API}/loads`)
      .send({
        customerId: betaCustomerId,
        stops: DALLAS_CHICAGO_STOPS,
        equipmentType: 'DRY_VAN',
        customerRate: '950.00',
      })
      .expect(201);
    loadOwnedBySalesId = ownRes.body.id;
    await adminAgent.post(`${API}/loads/${loadOwnedBySalesId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadOwnedBySalesId}/assign-carrier`)
      .send({ carrierId, carrierRate: '700.00' })
      .expect(200);

    loadClosedId = await createLoad(
      adminAgent,
      alphaCustomerId,
      DALLAS_CHICAGO_STOPS,
      'DRY_VAN',
      '1200.00',
    );
    await progressToDelivered(loadClosedId, carrierId);
    await adminAgent.post(`${API}/loads/${loadClosedId}/close`).expect(200);

    loadEarlyId = await createLoad(adminAgent, alphaCustomerId, EARLY_STOPS, 'DRY_VAN', '1000.00');
    loadLateId = await createLoad(adminAgent, alphaCustomerId, LATE_STOPS, 'DRY_VAN', '1000.00');
  }, 60000);

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

    const adminEmail = `admin-${seed}@load-search-test.test`;
    const salesEmail = `sales-${seed}@load-search-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@load-search-test.test`;
    const accountingEmail = `accounting-${seed}@load-search-test.test`;
    const reviewerEmail = `reviewer-${seed}@load-search-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Load Search Test Org ${seed}`,
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
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerAgentLocal = await activateAndLogin(reviewerEmail, 'ReviewerPass123');

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
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
        legalName: `Load Search Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@load-search-customer.test`,
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
    carrierIdArg: string,
    documentTypeId: string,
    fileName: string,
  ): Promise<string> {
    const initiateRes = await agent
      .post(`${API}/carriers/${carrierIdArg}/documents`)
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

  async function createEligibleCarrier(seed: string): Promise<string> {
    const res = await adminAgent
      .post(`${API}/carriers`)
      .send({
        legalName: `Eligible Carrier ${seed}`,
        mcNumber: `MC-LS-${seed}`,
        dotNumber: `DOT-LS-${seed}`,
        addressLine1: '5 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        primaryContactName: 'Carrier Dispatch',
        primaryContactPhone: '555-0300',
        primaryContactEmail: `dispatch-${seed}@load-search-carrier.test`,
      })
      .expect(201);
    const carrierIdLocal: string = res.body.id;

    const w9Id = await uploadAndConfirm(adminAgent, carrierIdLocal, w9TypeId, 'w9.pdf');
    const caId = await uploadAndConfirm(
      adminAgent,
      carrierIdLocal,
      carrierAgreementTypeId,
      'agreement.pdf',
    );
    const mcId = await uploadAndConfirm(adminAgent, carrierIdLocal, mcAuthorityTypeId, 'mc.pdf');
    const coiId = await uploadAndConfirm(adminAgent, carrierIdLocal, coiTypeId, 'coi.pdf');
    for (const id of [w9Id, caId, mcId, coiId]) {
      expect(await waitForScanStatus(id)).toBe('CLEAN');
    }
    for (const id of [w9Id, caId, mcId, coiId]) {
      await reviewerAgent
        .post(`${API}/carriers/${carrierIdLocal}/documents/${id}/review`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    }
    for (const coverageType of ['AUTO_LIABILITY', 'CARGO']) {
      await adminAgent
        .post(`${API}/carriers/${carrierIdLocal}/insurance`)
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
      .post(`${API}/carriers/${carrierIdLocal}/fmcsa-verification`)
      .send({ verificationDate: '2026-01-01', resultStatus: 'Authorized' })
      .expect(201);
    await reviewerAgent.post(`${API}/carriers/${carrierIdLocal}/activate`).expect(200);
    return carrierIdLocal;
  }

  async function createLoad(
    agent: SuperAgentTest,
    customerId: string,
    stops: unknown[],
    equipmentType: string,
    customerRate: string,
  ): Promise<string> {
    const res = await agent
      .post(`${API}/loads`)
      .send({ customerId, stops, equipmentType, customerRate })
      .expect(201);
    return res.body.id;
  }

  async function progressToDelivered(loadId: string, carrierIdArg: string): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId: carrierIdArg, carrierRate: '1500.00' })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/departure`).send({}).expect(200);
  }

  function idsOf(body: { items: { id: string }[] }): string[] {
    return body.items.map((i) => i.id);
  }

  describe('GET /loads/search — filters', () => {
    it('filters by customerId', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ customerId: betaCustomerId })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadBetaId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });

    it('filters by equipmentType', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ equipmentType: 'REEFER' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadBetaId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });

    it('filters by carrierId', async () => {
      const res = await adminAgent.get(`${API}/loads/search`).query({ carrierId }).expect(200);
      const ids = idsOf(res.body);
      expect(ids).toEqual(expect.arrayContaining([loadWithCarrierId, loadOwnedBySalesId]));
      expect(ids).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });

    it('filters by riskStatus', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ riskStatus: 'AT_RISK' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadWithCarrierId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });

    it('filters by a Pickup Date range through the nested Stop relation', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ pickupFrom: '2026-01-01', pickupTo: '2026-01-31' })
        .expect(200);
      const ids = idsOf(res.body);
      expect(ids).toEqual(expect.arrayContaining([loadEarlyId]));
      expect(ids).not.toEqual(expect.arrayContaining([loadLateId]));
    });

    it('filters by a Delivery Date range through the nested Stop relation', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ deliveryFrom: '2026-03-01', deliveryTo: '2026-03-31' })
        .expect(200);
      const ids = idsOf(res.body);
      expect(ids).toEqual(expect.arrayContaining([loadLateId]));
      expect(ids).not.toEqual(expect.arrayContaining([loadEarlyId]));
    });

    it("includes Closed loads by default, unlike Dispatch Board Table View's default exclusion", async () => {
      const res = await adminAgent.get(`${API}/loads/search`).expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadClosedId]));
    });

    it('filters by status explicitly (e.g. CLOSED only)', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ status: 'CLOSED' })
        .expect(200);
      const ids = idsOf(res.body);
      expect(ids).toEqual(expect.arrayContaining([loadClosedId]));
      expect(ids).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });
  });

  describe('GET /loads/search — free-text search', () => {
    it('matches Load #', async () => {
      const loadNumberRes = await adminAgent.get(`${API}/loads/${loadAlphaId}`).expect(200);
      const loadNumber: string = loadNumberRes.body.loadNumber;
      const res = await adminAgent.get(`${API}/loads/search`).query({ q: loadNumber }).expect(200);
      expect(idsOf(res.body)).toEqual([loadAlphaId]);
    });

    it('matches Customer name', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ q: 'Customer beta' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadBetaId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });

    it('matches Carrier name', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ q: 'Eligible Carrier main' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(
        expect.arrayContaining([loadWithCarrierId, loadOwnedBySalesId]),
      );
    });

    it('matches Origin/Destination stop city text', async () => {
      const res = await adminAgent.get(`${API}/loads/search`).query({ q: 'Houston' }).expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([loadBetaId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));
    });
  });

  describe('GET /loads/search — sorting', () => {
    it('sorts by Pickup Date ascending', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ sort: 'pickupDate', sortDirection: 'asc', pageSize: 100 })
        .expect(200);
      const ids = idsOf(res.body);
      expect(ids.indexOf(loadEarlyId)).toBeLessThan(ids.indexOf(loadLateId));
    });

    it('sorts by Delivery Date descending', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ sort: 'deliveryDate', sortDirection: 'desc', pageSize: 100 })
        .expect(200);
      const ids = idsOf(res.body);
      expect(ids.indexOf(loadLateId)).toBeLessThan(ids.indexOf(loadEarlyId));
    });

    it('sorts by Load # ascending', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search`)
        .query({ sort: 'loadNumber', sortDirection: 'asc', pageSize: 100 })
        .expect(200);
      const numbers = (res.body.items as { loadNumber: string }[]).map((i) => i.loadNumber);
      const sorted = [...numbers].sort();
      expect(numbers).toEqual(sorted);
    });
  });

  describe('GET /loads/search — pagination', () => {
    it('defaults to a page size of 50', async () => {
      const res = await adminAgent.get(`${API}/loads/search`).expect(200);
      expect(res.body.pageSize).toBe(50);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBeGreaterThanOrEqual(7);
    });

    it('honors an explicit page/pageSize and reports the same total across pages', async () => {
      const page1 = await adminAgent
        .get(`${API}/loads/search`)
        .query({ pageSize: 2, page: 1 })
        .expect(200);
      const page2 = await adminAgent
        .get(`${API}/loads/search`)
        .query({ pageSize: 2, page: 2 })
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page2.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(page2.body.total);
      expect(idsOf(page1.body)).not.toEqual(idsOf(page2.body));
    });
  });

  describe('GET /loads/search — financial redaction (reuses shapeFinancialFieldsList)', () => {
    it('Dispatcher never sees customerRate or carrierRate', async () => {
      const res = await dispatcherAgent
        .get(`${API}/loads/search`)
        .query({ pageSize: 100 })
        .expect(200);
      const row = (
        res.body.items as { id: string; customerRate: unknown; carrierRate: unknown }[]
      ).find((i) => i.id === loadWithCarrierId);
      expect(row?.customerRate).toBeNull();
      expect(row?.carrierRate).toBeNull();
    });

    it('Sales/Booking sees customerRate only on their own Load, and never carrierRate regardless of ownership', async () => {
      const res = await salesAgent.get(`${API}/loads/search`).query({ pageSize: 100 }).expect(200);
      const items = res.body.items as {
        id: string;
        customerRate: unknown;
        carrierRate: unknown;
      }[];
      const own = items.find((i) => i.id === loadOwnedBySalesId);
      const notOwn = items.find((i) => i.id === loadWithCarrierId);
      expect(own?.customerRate).not.toBeNull();
      expect(own?.carrierRate).toBeNull();
      expect(notOwn?.customerRate).toBeNull();
      expect(notOwn?.carrierRate).toBeNull();
    });

    it('Admin and Accounting see both customerRate and carrierRate', async () => {
      for (const agent of [adminAgent, accountingAgent]) {
        const res = await agent.get(`${API}/loads/search`).query({ pageSize: 100 }).expect(200);
        const row = (
          res.body.items as { id: string; customerRate: unknown; carrierRate: unknown }[]
        ).find((i) => i.id === loadWithCarrierId);
        expect(row?.customerRate).not.toBeNull();
        expect(row?.carrierRate).not.toBeNull();
      }
    });
  });

  describe('GET /loads/search/export', () => {
    it('returns CSV with the correct headers and every matching row, not just one page', async () => {
      const res = await adminAgent
        .get(`${API}/loads/search/export`)
        .query({ customerId: alphaCustomerId })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('.csv');
      const lines = (res.text as string).trim().split('\r\n');
      expect(lines[0]).toBe(
        'Load #,Customer,Status,Risk,Carrier,Dispatcher,Origin → Destination,Pickup Date,Delivery Date,Equipment,Customer Rate,Carrier Rate',
      );
      // Alpha customer has more loads than the default page size would show on a narrow page — export is unpaginated.
      expect(lines.length - 1).toBeGreaterThanOrEqual(4);
    });

    it('redacts financial fields in the CSV per the requesting role, same as the JSON endpoint', async () => {
      const res = await dispatcherAgent
        .get(`${API}/loads/search/export`)
        .query({ carrierId })
        .expect(200);
      const lines = (res.text as string).trim().split('\r\n');
      // Last two columns (Customer Rate, Carrier Rate) must be empty for every data row.
      for (const line of lines.slice(1)) {
        expect(line.endsWith(',,')).toBe(true);
      }
    });
  });

  describe('GET /loads is unaffected by this phase', () => {
    it('still returns a bare array (not the new {items,total,...} shape) and still excludes nothing itself', async () => {
      const res = await adminAgent.get(`${API}/loads`).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('Cross-tenant isolation', () => {
    it("never returns another organization's Loads from search or export", async () => {
      const orgB = await setUpOrganization('cross-b');

      const searchRes = await orgB.adminAgent.get(`${API}/loads/search`).expect(200);
      expect(idsOf(searchRes.body)).not.toEqual(expect.arrayContaining([loadAlphaId]));

      const exportRes = await orgB.adminAgent.get(`${API}/loads/search/export`).expect(200);
      expect(exportRes.text).not.toContain(loadAlphaId);

      const rowsWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM load WHERE id = ${loadAlphaId}::uuid AND organization_id = ${orgId}::uuid`,
      );
      expect(rowsWrongTenant).toHaveLength(0);
    }, 30000);
  });
});
