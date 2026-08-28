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

const DISPATCH_BODY = {
  driverName: 'Jane Driver',
  driverPhone: '555-9000',
  truckNumber: 'T-100',
  trailerNumber: 'TR-100',
};

/**
 * Frontend Phase 20 (Document Center) end-to-end proof: `GET
 * /documents/search` and `GET /documents/search/export`. Per the approved
 * implementation plan, scope here is: filters/sort/pagination sanity,
 * cross-entity-type Tier 1/2 search resolution (including STOP/POD via its
 * parent Load), the CARRIER_PAYMENT (FINANCIAL_VIEW_ROLES) and INVOICE
 * (mirrors InvoiceService.findById/isOwnDeal, both the accountOwnerUserId
 * and createdByUserId-fallback branches) visibility matrices, CSV
 * export/JSON authorization parity, and cross-tenant isolation.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Document Center — Search & Export (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'document-search-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let opsManagerAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let orgId: string;

  let w9TypeId: string;
  let coiTypeId: string;
  let carrierAgreementTypeId: string;
  let mcAuthorityTypeId: string;

  let carrierId: string;
  let carrierDocId: string; // "coi.pdf" from createEligibleCarrier
  let alphaCustomerId: string;
  let customerDocId: string;
  let loadId: string;
  let loadNumber: string;

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
        name: 'Document Search Suite Platform Super Admin',
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
    opsManagerAgent = org.opsManagerAgent;
    reviewerAgent = org.reviewerAgent;

    alphaCustomerId = await createActiveCustomer(adminAgent, 'alpha');
    carrierId = await createEligibleCarrier('main');

    const customerDocRes = await uploadAndConfirm(
      adminAgent,
      'CUSTOMER',
      alphaCustomerId,
      w9TypeId,
      'customer-w9.pdf',
    );
    customerDocId = customerDocRes;
    await waitForScanStatus(customerDocId);

    const carrierDocsRes = await adminAgent
      .get(`${API}/documents`)
      .query({ entityType: 'CARRIER', entityId: carrierId })
      .expect(200);
    carrierDocId = carrierDocsRes.body.find((d: { fileName: string }) =>
      d.fileName.startsWith('coi'),
    ).id;

    const loadRes = await adminAgent
      .post(`${API}/loads`)
      .send({
        customerId: alphaCustomerId,
        stops: LOAD_STOPS,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      })
      .expect(201);
    loadId = loadRes.body.id;
    loadNumber = loadRes.body.loadNumber;
  }, 60000);

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

    const adminEmail = `admin-${seed}@document-search-test.test`;
    const salesEmail = `sales-${seed}@document-search-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@document-search-test.test`;
    const accountingEmail = `accounting-${seed}@document-search-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@document-search-test.test`;
    const reviewerEmail = `reviewer-${seed}@document-search-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Document Search Test Org ${seed}`,
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

  async function createActiveCustomer(
    agent: SuperAgentTest,
    seed: string,
    accountOwnerUserId?: string,
  ): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Document Search Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@document-search-customer.test`,
        primaryContactPhone: '555-0200',
        paymentTermsOverride: 'NET_30',
        accountOwnerUserId,
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
    entityType: string,
    entityId: string,
    documentTypeId: string,
    fileName: string,
  ): Promise<string> {
    const initiateRes = await agent
      .post(`${API}/documents`)
      .send({
        entityType,
        entityId,
        documentTypeId,
        fileName,
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
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

  async function uploadCarrierDoc(
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
        mcNumber: `MC-DS-${seed}`,
        dotNumber: `DOT-DS-${seed}`,
        addressLine1: '5 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        primaryContactName: 'Carrier Dispatch',
        primaryContactPhone: '555-0300',
        primaryContactEmail: `dispatch-${seed}@document-search-carrier.test`,
      })
      .expect(201);
    const carrierIdLocal: string = res.body.id;

    const w9Id = await uploadCarrierDoc(adminAgent, carrierIdLocal, w9TypeId, 'w9.pdf');
    const caId = await uploadCarrierDoc(
      adminAgent,
      carrierIdLocal,
      carrierAgreementTypeId,
      'agreement.pdf',
    );
    const mcId = await uploadCarrierDoc(adminAgent, carrierIdLocal, mcAuthorityTypeId, 'mc.pdf');
    const coiId = await uploadCarrierDoc(adminAgent, carrierIdLocal, coiTypeId, 'coi.pdf');
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

  async function progressToDelivered(
    loadIdArg: string,
    carrierIdArg: string,
    carrierRate = '1500.00',
  ): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadIdArg}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadIdArg}/assign-carrier`)
      .send({ carrierId: carrierIdArg, carrierRate })
      .expect(200);
    await adminAgent
      .post(`${API}/loads/${loadIdArg}/generate-rate-confirmation`)
      .send({})
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadIdArg}/dispatch`).send(DISPATCH_BODY).expect(200);
    await adminAgent.post(`${API}/loads/${loadIdArg}/stops/1/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadIdArg}/stops/1/departure`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadIdArg}/stops/2/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadIdArg}/stops/2/departure`).send({}).expect(200);
  }

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }

  /** Books, delivers, invoices, and sends an Invoice — produces a real INVOICE-type Document. */
  async function createSentInvoice(
    seed: string,
    customerId: string,
  ): Promise<{ invoiceId: string; loadIdArg: string }> {
    const loadRes = await adminAgent
      .post(`${API}/loads`)
      .send({
        customerId,
        stops: LOAD_STOPS,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      })
      .expect(201);
    const loadIdArg: string = loadRes.body.id;
    await progressToDelivered(loadIdArg, carrierId);
    const invoiceRes = await accountingAgent
      .post(`${API}/invoices`)
      .send({ customerId, loadIds: [loadIdArg], podWarningAcknowledged: true })
      .expect(201);
    const invoiceId: string = invoiceRes.body.id;
    await accountingAgent
      .post(`${API}/invoices/${invoiceId}/send`)
      .send({ recipientEmail: 'ap@customer.test', subject: 'Invoice', message: 'See attached.' })
      .expect(200);
    return { invoiceId, loadIdArg };
  }

  /** Runs a Carrier Payment through Draft -> Submit -> Approve -> Mark Paid — produces a CARRIER_PAYMENT-type Document. */
  async function createPaidCarrierPayment(seed: string): Promise<{ paymentId: string }> {
    const loadRes = await adminAgent
      .post(`${API}/loads`)
      .send({
        customerId: alphaCustomerId,
        stops: LOAD_STOPS,
        equipmentType: 'DRY_VAN',
        customerRate: '1800.00',
      })
      .expect(201);
    const loadIdArg: string = loadRes.body.id;
    await progressToDelivered(loadIdArg, carrierId);

    const draft = await accountingAgent
      .post(`${API}/loads/${loadIdArg}/carrier-payments`)
      .send({
        paymentType: 'BALANCE',
        amount: '1500.00',
        method: 'ACH',
        referenceNumber: `REF-${seed}`,
      })
      .expect(201);
    await accountingAgent.post(`${API}/carrier-payments/${draft.body.id}/submit`).expect(200);
    await adminAgent.post(`${API}/carrier-payments/${draft.body.id}/approve`).expect(200);
    await accountingAgent
      .post(`${API}/carrier-payments/${draft.body.id}/mark-paid`)
      .send({})
      .expect(200);
    return { paymentId: draft.body.id };
  }

  function idsOf(body: { items: { id: string }[] }): string[] {
    return body.items.map((i) => i.id);
  }

  describe('GET /documents/search — filters', () => {
    it('filters by entityType', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ entityType: 'CUSTOMER' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([customerDocId]));
      expect(idsOf(res.body)).not.toEqual(expect.arrayContaining([carrierDocId]));
    });

    it('filters by documentTypeId', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ documentTypeId: coiTypeId })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([carrierDocId]));
    });

    it('filters by scanStatus', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ scanStatus: 'CLEAN' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([customerDocId, carrierDocId]));
    });
  });

  describe('GET /documents/search — free-text search resolves through the owning entity', () => {
    it('matches a Customer document by the Customer legal name', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ q: 'Document Search Customer alpha' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([customerDocId]));
    });

    it('matches a Carrier document by the Carrier legal name', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ q: 'Eligible Carrier main' })
        .expect(200);
      expect(idsOf(res.body)).toEqual(expect.arrayContaining([carrierDocId]));
    });

    it('matches a document directly by fileName', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ q: 'customer-w9' })
        .expect(200);
      expect(idsOf(res.body)).toEqual([customerDocId]);
    });
  });

  describe('GET /documents/search — sort and pagination', () => {
    it('defaults to a page size of 50', async () => {
      const res = await adminAgent.get(`${API}/documents/search`).expect(200);
      expect(res.body.pageSize).toBe(50);
      expect(res.body.page).toBe(1);
    });

    it('honors an explicit page/pageSize and reports the same total across pages', async () => {
      const page1 = await adminAgent
        .get(`${API}/documents/search`)
        .query({ pageSize: 1, page: 1 })
        .expect(200);
      const page2 = await adminAgent
        .get(`${API}/documents/search`)
        .query({ pageSize: 1, page: 2 })
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page2.body.items).toHaveLength(1);
      expect(page1.body.total).toBe(page2.body.total);
      expect(idsOf(page1.body)).not.toEqual(idsOf(page2.body));
    });

    it('sorts by fileName ascending', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ sort: 'fileName', sortDirection: 'asc', pageSize: 100 })
        .expect(200);
      const names = (res.body.items as { fileName: string }[]).map((i) => i.fileName);
      expect(names).toEqual([...names].sort());
    });
  });

  describe('GET /documents/search — Carrier Payment visibility (FINANCIAL_VIEW_ROLES)', () => {
    it('Dispatcher and Sales/Booking never see a CARRIER_PAYMENT-type document', async () => {
      const { paymentId } = await createPaidCarrierPayment('cp-vis-1');

      for (const agent of [dispatcherAgent, salesAgent]) {
        const res = await agent
          .get(`${API}/documents/search`)
          .query({ entityType: 'CARRIER_PAYMENT', pageSize: 100 })
          .expect(200);
        expect(
          res.body.items.find((i: { entityId: string }) => i.entityId === paymentId),
        ).toBeUndefined();
      }
    });

    it('Admin, Accounting, and Operations Manager see the settlement document', async () => {
      const { paymentId } = await createPaidCarrierPayment('cp-vis-2');

      for (const agent of [adminAgent, accountingAgent, opsManagerAgent]) {
        const res = await agent
          .get(`${API}/documents/search`)
          .query({ entityType: 'CARRIER_PAYMENT', pageSize: 100 })
          .expect(200);
        expect(
          res.body.items.find((i: { entityId: string }) => i.entityId === paymentId),
        ).toBeDefined();
      }
    });
  });

  describe('GET /documents/search — Invoice visibility (mirrors InvoiceService.findById/isOwnDeal)', () => {
    it('a pure Dispatcher sees zero INVOICE-type documents, matching INVOICE_VIEW_ROLES exclusion', async () => {
      const { invoiceId } = await createSentInvoice('inv-vis-dispatcher', alphaCustomerId);

      const res = await dispatcherAgent
        .get(`${API}/documents/search`)
        .query({ entityType: 'INVOICE', pageSize: 100 })
        .expect(200);
      expect(
        res.body.items.find((i: { entityId: string }) => i.entityId === invoiceId),
      ).toBeUndefined();
    });

    it('Sales/Booking sees an Invoice document owned via the Customer accountOwnerUserId, and not one they do not own', async () => {
      const salesUserId = await currentUserId(salesAgent);
      const ownedCustomerId = await createActiveCustomer(
        adminAgent,
        'inv-owner-account',
        salesUserId,
      );
      const { invoiceId: ownedInvoiceId } = await createSentInvoice(
        'inv-vis-owned-account',
        ownedCustomerId,
      );
      const { invoiceId: otherInvoiceId } = await createSentInvoice(
        'inv-vis-other',
        alphaCustomerId,
      );

      const res = await salesAgent
        .get(`${API}/documents/search`)
        .query({ entityType: 'INVOICE', pageSize: 100 })
        .expect(200);
      const ids = res.body.items.map((i: { entityId: string }) => i.entityId);
      expect(ids).toEqual(expect.arrayContaining([ownedInvoiceId]));
      expect(ids).not.toEqual(expect.arrayContaining([otherInvoiceId]));
    });

    it('Sales/Booking sees an Invoice document owned via the createdByUserId fallback (no accountOwnerUserId set)', async () => {
      const ownRes = await salesAgent
        .post(`${API}/customers`)
        .send({
          legalName: 'Document Search Sales-Created Customer',
          billingAddressLine1: '1 Commerce St',
          billingCity: 'Fort Worth',
          billingState: 'TX',
          billingZip: '76102',
          primaryContactName: 'Contact',
          primaryContactEmail: 'contact-inv-fallback@document-search-customer.test',
          primaryContactPhone: '555-0200',
          paymentTermsOverride: 'NET_30',
          acknowledgeDuplicates: true,
        })
        .expect(201);
      const ownCustomerId: string = ownRes.body.id;
      await adminAgent
        .post(`${API}/customers/${ownCustomerId}/status`)
        .send({ status: 'ACTIVE' })
        .expect(200);

      const { invoiceId } = await createSentInvoice('inv-vis-fallback', ownCustomerId);

      const res = await salesAgent
        .get(`${API}/documents/search`)
        .query({ entityType: 'INVOICE', pageSize: 100 })
        .expect(200);
      expect(
        res.body.items.find((i: { entityId: string }) => i.entityId === invoiceId),
      ).toBeDefined();
    });

    it('Admin and Accounting see every Invoice document regardless of ownership', async () => {
      const { invoiceId } = await createSentInvoice('inv-vis-full', alphaCustomerId);

      for (const agent of [adminAgent, accountingAgent]) {
        const res = await agent
          .get(`${API}/documents/search`)
          .query({ entityType: 'INVOICE', pageSize: 100 })
          .expect(200);
        expect(
          res.body.items.find((i: { entityId: string }) => i.entityId === invoiceId),
        ).toBeDefined();
      }
    });
  });

  describe('GET /documents/search/export', () => {
    it('returns CSV with the correct header and includes matching rows, unpaginated', async () => {
      const res = await adminAgent
        .get(`${API}/documents/search/export`)
        .query({ entityType: 'CUSTOMER' })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const lines = (res.text as string).trim().split('\r\n');
      expect(lines[0]).toBe(
        'File Name,Document Type,Entity Type,Entity Identifier,Scan Status,Review Status,Generation Status,Uploaded By,Uploaded At',
      );
      expect(res.text).toContain('customer-w9.pdf');
    });

    it('applies the identical CARRIER_PAYMENT/INVOICE authorization as the JSON endpoint — Dispatcher export excludes both', async () => {
      const { paymentId } = await createPaidCarrierPayment('cp-export-parity');
      const { invoiceId } = await createSentInvoice('inv-export-parity', alphaCustomerId);

      const jsonRes = await dispatcherAgent
        .get(`${API}/documents/search`)
        .query({ pageSize: 200 })
        .expect(200);
      const jsonIds = jsonRes.body.items.map((i: { entityId: string }) => i.entityId);
      expect(jsonIds).not.toEqual(expect.arrayContaining([paymentId, invoiceId]));

      const exportRes = await dispatcherAgent.get(`${API}/documents/search/export`).expect(200);
      expect(exportRes.text).not.toContain(paymentId);
      expect(exportRes.text).not.toContain(invoiceId);
    });
  });

  describe('GET /documents/search — Load document resolution and identifier', () => {
    it('resolves a Load document to its Load # and links to the Load detail route', async () => {
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/assign-carrier`)
        .send({ carrierId, carrierRate: '1500.00' })
        .expect(200);
      await adminAgent
        .post(`${API}/loads/${loadId}/generate-rate-confirmation`)
        .send({})
        .expect(200);

      const res = await adminAgent
        .get(`${API}/documents/search`)
        .query({ entityType: 'LOAD', pageSize: 100 })
        .expect(200);
      const row = res.body.items.find((i: { entityId: string }) => i.entityId === loadId);
      expect(row).toBeDefined();
      expect(row.entityLabel).toBe(loadNumber);
      expect(row.entityLinkPath).toBe(`/loads/${loadId}`);
    });
  });

  describe('Cross-tenant isolation', () => {
    it("never returns another organization's documents from search or export", async () => {
      const orgB = await setUpOrganization('cross-b');

      const searchRes = await orgB.adminAgent.get(`${API}/documents/search`).expect(200);
      expect(idsOf(searchRes.body)).not.toEqual(
        expect.arrayContaining([customerDocId, carrierDocId]),
      );

      const exportRes = await orgB.adminAgent.get(`${API}/documents/search/export`).expect(200);
      expect(exportRes.text).not.toContain(customerDocId);
      expect(exportRes.text).not.toContain(carrierDocId);

      const rowsWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM document WHERE id = ${customerDocId}::uuid AND organization_id = ${orgId}::uuid`,
      );
      expect(rowsWrongTenant).toHaveLength(0);
    }, 30000);

    it("a manipulated entityType/q filter never surfaces another organization's rows via search", async () => {
      const orgB = await setUpOrganization('cross-bypass');

      const res = await orgB.adminAgent
        .get(`${API}/documents/search`)
        .query({ q: 'Document Search Customer alpha', entityType: 'CUSTOMER' })
        .expect(200);
      expect(idsOf(res.body)).toHaveLength(0);
    }, 30000);
  });
});
