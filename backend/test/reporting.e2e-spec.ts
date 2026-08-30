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
 * Phase 8 (Reporting Foundation) end-to-end proof: Global Search (§5.4,
 * Decision B4) across Load/Customer/Carrier/Invoice with financial
 * redaction, AR Aging and AP Aging's locked bucket math (DATABASE_DESIGN.md
 * §21, Decision D14, including the disclosed oldest-unresolved-payment
 * anchor for multi-payment Loads), the role-aware Dashboard's approved
 * minimal KPI set (Decision 3), and the Decision 4 endpoint-level
 * financial-report permission gate.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Reporting (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'reporting-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let opsManagerAgent: SuperAgentTest;
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
        name: 'Reporting Suite Platform Super Admin',
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
    orgId = org.organizationId;
    adminAgent = org.adminAgent;
    dispatcherAgent = org.dispatcherAgent;
    salesAgent = org.salesAgent;
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

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }

  async function setUpOrganization(seed: string) {
    const superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@reporting-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@reporting-test.test`;
    const salesEmail = `sales-${seed}@reporting-test.test`;
    const accountingEmail = `accounting-${seed}@reporting-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@reporting-test.test`;
    const reviewerEmail = `reviewer-${seed}@reporting-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Reporting Test Org ${seed}`,
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
      .send({ email: salesEmail, roles: ['SALES_BOOKING'] })
      .expect(201);
    const salesAgentLocal = await activateAndLogin(salesEmail, 'SalesPass123');

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
      dispatcherAgent: dispatcherAgentLocal,
      salesAgent: salesAgentLocal,
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
        legalName: `Reporting Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@reporting-customer.test`,
        primaryContactPhone: '555-0200',
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

  async function createEligibleCarrier(seed: string): Promise<string> {
    const res = await adminAgent
      .post(`${API}/carriers`)
      .send({
        legalName: `Reporting Carrier ${seed}`,
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

  async function createBookedLoad(
    seed: string,
    customerId?: string,
    customerRate = '1800.00',
  ): Promise<{ loadId: string; customerId: string }> {
    const custId = customerId ?? (await createActiveCustomer(adminAgent, seed));
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId: custId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate })
      .expect(201);
    return { loadId: res.body.id, customerId: custId };
  }

  async function progressToDelivered(
    loadId: string,
    carrierId: string,
    carrierRate = '1500.00',
  ): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/1/departure`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/arrival`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/stops/2/departure`).send({}).expect(200);
  }

  function daysAgoIso(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  describe('Global Search — §5.4 / Decision B4', () => {
    it('finds a Load/Customer/Carrier/Invoice by their searchable identifier, redacting per role exactly as their own detail endpoints would', async () => {
      const carrierId = await createEligibleCarrier('search');
      const { loadId, customerId } = await createBookedLoad('search-target', undefined, '2222.00');
      await progressToDelivered(loadId, carrierId);
      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);

      const loadDetail = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const loadNumber: string = loadDetail.body.loadNumber;

      const adminSearch = await adminAgent
        .get(`${API}/search`)
        .query({ q: loadNumber })
        .expect(200);
      expect(adminSearch.body.loads.some((l: { id: string }) => l.id === loadId)).toBe(true);
      const adminLoadHit = adminSearch.body.loads.find((l: { id: string }) => l.id === loadId);
      expect(adminLoadHit.customerRate).not.toBeNull();

      const dispatcherSearch = await dispatcherAgent
        .get(`${API}/search`)
        .query({ q: loadNumber })
        .expect(200);
      const dispatcherLoadHit = dispatcherSearch.body.loads.find(
        (l: { id: string }) => l.id === loadId,
      );
      expect(dispatcherLoadHit.customerRate).toBeNull();

      const invoiceNumber: string = invoiceRes.body.invoiceNumber;
      const dispatcherInvoiceSearch = await dispatcherAgent
        .get(`${API}/search`)
        .query({ q: invoiceNumber })
        .expect(200);
      expect(dispatcherInvoiceSearch.body.invoices).toHaveLength(0);

      const adminInvoiceSearch = await adminAgent
        .get(`${API}/search`)
        .query({ q: invoiceNumber })
        .expect(200);
      expect(
        adminInvoiceSearch.body.invoices.some((i: { id: string }) => i.id === invoiceRes.body.id),
      ).toBe(true);
    });

    it('redacts a non-owned invoice for Sales/Booking but shows full amounts for their own-deal invoice', async () => {
      const salesUserId = await currentUserId(salesAgent);
      const carrierId = await createEligibleCarrier('search-sales');
      const ownedCustomerId = await createActiveCustomer(
        adminAgent,
        'search-sales-owned',
        salesUserId,
      );
      const { loadId: ownedLoadId } = await createBookedLoad(
        'search-sales-owned',
        ownedCustomerId,
        '1234.00',
      );
      await progressToDelivered(ownedLoadId, carrierId);
      const ownedInvoice = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId: ownedCustomerId, loadIds: [ownedLoadId], podWarningAcknowledged: true })
        .expect(201);

      const { loadId: otherLoadId, customerId: otherCustomerId } =
        await createBookedLoad('search-sales-other');
      await progressToDelivered(otherLoadId, carrierId);
      const otherInvoice = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId: otherCustomerId, loadIds: [otherLoadId], podWarningAcknowledged: true })
        .expect(201);

      const ownedSearch = await salesAgent
        .get(`${API}/search`)
        .query({ q: ownedInvoice.body.invoiceNumber })
        .expect(200);
      expect(ownedSearch.body.invoices[0].total).not.toBeNull();

      const otherSearch = await salesAgent
        .get(`${API}/search`)
        .query({ q: otherInvoice.body.invoiceNumber })
        .expect(200);
      expect(otherSearch.body.invoices[0].total).toBeNull();
    });
  });

  describe('AR Aging — DATABASE_DESIGN.md §21 / Decision 5', () => {
    async function createSentInvoiceWithDueDate(seed: string, dueDaysAgo: number): Promise<string> {
      const carrierId = await createEligibleCarrier(seed);
      const { loadId, customerId } = await createBookedLoad(seed, undefined, '1000.00');
      await progressToDelivered(loadId, carrierId);
      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);
      const invoiceId: string = invoiceRes.body.id;
      await accountingAgent
        .post(`${API}/invoices/${invoiceId}/send`)
        .send({ recipientEmail: 'ap@customer.test', subject: 'Invoice', message: 'See attached.' })
        .expect(200);

      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: { dueDate: new Date(daysAgoIso(dueDaysAgo)) },
        }),
      );
      return invoiceId;
    }

    it('buckets a 45-days-past-due invoice into 31-60, and a not-yet-due invoice into Current', async () => {
      await createSentInvoiceWithDueDate('ar-31to60', 45);
      await createSentInvoiceWithDueDate('ar-current', -10);

      const res = await accountingAgent.get(`${API}/reports/ar-aging`).expect(200);

      expect(res.body.buckets.days31to60.count).toBeGreaterThanOrEqual(1);
      expect(res.body.buckets.current.count).toBeGreaterThanOrEqual(1);
    });

    it('blocks Dispatcher and Sales/Booking from AR Aging (Decision 4)', async () => {
      await dispatcherAgent.get(`${API}/reports/ar-aging`).expect(403);
      await salesAgent.get(`${API}/reports/ar-aging`).expect(403);
    });

    it('allows Operations Manager to view AR Aging', async () => {
      await opsManagerAgent.get(`${API}/reports/ar-aging`).expect(200);
    });
  });

  describe('AP Aging — Decision D14 / disclosed multi-payment interpretation', () => {
    it('anchors on the OLDEST unresolved CarrierPayment when a Load has multiple, and excludes a fully-DRAFT Load', async () => {
      const carrierId = await createEligibleCarrier('ap-multi');
      const { loadId } = await createBookedLoad('ap-multi', undefined, '900.00');
      await progressToDelivered(loadId, carrierId, '1500.00');

      const older = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({
          paymentType: 'DEPOSIT',
          amount: '500.00',
          method: 'ACH',
          referenceNumber: 'REF-OLD',
        })
        .expect(201);
      await accountingAgent.post(`${API}/carrier-payments/${older.body.id}/submit`).expect(200);
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.carrierPayment.update({
          where: { id: older.body.id },
          data: { submittedAt: new Date(daysAgoIso(70)) },
        }),
      );

      const newer = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({
          paymentType: 'BALANCE',
          amount: '1000.00',
          method: 'ACH',
          referenceNumber: 'REF-NEW',
        })
        .expect(201);
      await accountingAgent.post(`${API}/carrier-payments/${newer.body.id}/submit`).expect(200);
      await prisma.withTenantTransaction(orgId, (tx) =>
        tx.carrierPayment.update({
          where: { id: newer.body.id },
          data: { submittedAt: new Date(daysAgoIso(5)) },
        }),
      );

      const draftOnlyCarrier = await createEligibleCarrier('ap-draft-only');
      const { loadId: draftOnlyLoadId } = await createBookedLoad(
        'ap-draft-only',
        undefined,
        '600.00',
      );
      await progressToDelivered(draftOnlyLoadId, draftOnlyCarrier, '800.00');
      await accountingAgent
        .post(`${API}/loads/${draftOnlyLoadId}/carrier-payments`)
        .send({ paymentType: 'DEPOSIT', amount: '200.00' })
        .expect(201);

      const res = await accountingAgent.get(`${API}/reports/ap-aging`).expect(200);

      // Outstanding for `loadId` = 1500 - 0(paid) = 1500, anchored on the
      // OLDER submission (70 days ago) -> 61-90 bucket.
      expect(res.body.buckets.days61to90.total).toBe('1500.00');
      // The draft-only Load's outstanding balance never appears anywhere —
      // "not yet aged" per D14, since it has no formally-submitted payment.
      const allBucketTotals = Object.values(
        res.body.buckets as Record<string, { total: string }>,
      ).reduce((sum, b) => sum + Number(b.total), 0);
      expect(allBucketTotals).toBe(1500);
    });

    it('blocks Dispatcher and Sales/Booking from AP Aging (Decision 4)', async () => {
      await dispatcherAgent.get(`${API}/reports/ap-aging`).expect(403);
      await salesAgent.get(`${API}/reports/ap-aging`).expect(403);
    });
  });

  describe('Dashboard — PRD §9 / Decision 3', () => {
    it('gives Dispatcher only their own scoped block, and Admin every block org-wide', async () => {
      const dispatcherUserId = await currentUserId(dispatcherAgent);
      const carrierId = await createEligibleCarrier('dash-dispatcher');
      const { loadId } = await createBookedLoad('dash-dispatcher');
      await adminAgent
        .patch(`${API}/loads/${loadId}/dispatcher`)
        .send({ dispatcherUserId })
        .expect(200);
      await progressToDelivered(loadId, carrierId);

      const dispatcherDash = await dispatcherAgent.get(`${API}/dashboard`).expect(200);
      expect(dispatcherDash.body).toHaveProperty('dispatcher');
      expect(dispatcherDash.body).not.toHaveProperty('sales');
      expect(dispatcherDash.body).not.toHaveProperty('accounting');

      const adminDash = await adminAgent.get(`${API}/dashboard`).expect(200);
      expect(adminDash.body).toHaveProperty('dispatcher');
      expect(adminDash.body).toHaveProperty('sales');
      expect(adminDash.body).toHaveProperty('accounting');
    });

    it('computes Sales/Booking win rate as won/(won+lost) over the last 30 days, and 0 when neither has happened', async () => {
      const freshSalesOrg = await setUpOrganization('dash-winrate');
      const zeroDash = await freshSalesOrg.salesAgent.get(`${API}/dashboard`).expect(200);
      expect(zeroDash.body.sales.winRate).toBe(0);

      const quoteStops = [
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
      const customerId = await createActiveCustomer(freshSalesOrg.adminAgent, 'dash-winrate');

      const wonQuoteRes = await freshSalesOrg.salesAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: quoteStops, equipmentType: 'DRY_VAN', customerRate: '1000.00' })
        .expect(201);
      await freshSalesOrg.salesAgent
        .post(`${API}/quotes/${wonQuoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '1000.00' })
        .expect(200);

      const lostQuoteRes = await freshSalesOrg.salesAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: quoteStops, equipmentType: 'DRY_VAN', customerRate: '1000.00' })
        .expect(201);
      await freshSalesOrg.salesAgent
        .post(`${API}/quotes/${lostQuoteRes.body.id}/mark-lost`)
        .send({ reason: 'Customer chose another carrier' })
        .expect(200);

      const dash = await freshSalesOrg.salesAgent.get(`${API}/dashboard`).expect(200);
      expect(dash.body.sales.wonLast30).toBe(1);
      expect(dash.body.sales.lostLast30).toBe(1);
      expect(dash.body.sales.winRate).toBe(0.5);
    });

    it('Compliance Reviewer (no approved KPI block) gets an empty dashboard', async () => {
      const res = await reviewerAgent.get(`${API}/dashboard`).expect(200);
      expect(res.body).toEqual({});
    });
  });

  describe('Cross-tenant isolation for Reporting endpoints', () => {
    it("one organization's data never leaks into another's search/aging/dashboard results", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      await createActiveCustomer(orgA.adminAgent, 'cross-a-unique-xyz');

      const searchFromB = await orgB.adminAgent
        .get(`${API}/search`)
        .query({ q: 'cross-a-unique-xyz' })
        .expect(200);
      expect(searchFromB.body.customers).toHaveLength(0);

      const arAgingB = await orgB.accountingAgent.get(`${API}/reports/ar-aging`).expect(200);
      expect(arAgingB.body.grandTotal).toBe('0.00');
    }, 30000);
  });
});
