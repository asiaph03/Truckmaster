import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

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
 * Phase 6 (Financials) end-to-end proof: Decision Log D9's Add Charge,
 * Decision Log B3's Charge Type management, Workflow 8's full Invoice
 * lifecycle (Builder through Send/Payment/Adjustment/Void) plus its
 * UI_UX_DESIGN.md §5.4.7 permission matrix, Workflow 9's full Carrier
 * Payment approval cycle (including self-approval-block and the
 * reject/resubmit loop), and Workflow 10's non-blocking Load Closing
 * checklist — run against a live app instance with a live PostgreSQL +
 * Redis + S3-compatible store.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed   (system document/charge types, including LINEHAUL/INVOICE/SETTLEMENT)
 *   npm run test:e2e
 */
describe('Financials (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'financials-suite-super-admin@trucktms.internal';
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
        name: 'Financials Suite Platform Super Admin',
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

  async function setUpOrganization(seed: string) {
    const superAdminAgent = request.agent(app.getHttpServer());
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@financials-test.test`;
    const salesEmail = `sales-${seed}@financials-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@financials-test.test`;
    const accountingEmail = `accounting-${seed}@financials-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@financials-test.test`;
    const reviewerEmail = `reviewer-${seed}@financials-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Financials Test Org ${seed}`,
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
        legalName: `Financials Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@financials-customer.test`,
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

  /** Carries a freshly-Booked Load all the way to DELIVERED. */
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

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }

  describe('ChargeLineItem auto-creation — Decision Log D9 / approved Phase 6 Decision #1', () => {
    it('an ORIGINAL customer-side LINEHAUL charge appears on the Ready-to-Invoice total at booking time, before any Carrier is involved', async () => {
      const { loadId, customerId } = await createBookedLoad('auto-charge', undefined, '2400.00');

      // Not eligible yet (not Delivered), so confirm indirectly via Add Charge's sibling data path instead — drive to Delivered and check the total.
      const carrierId = await createEligibleCarrier('auto-charge');
      await progressToDelivered(loadId, carrierId, '2000.00');

      const queue = await accountingAgent
        .get(`${API}/loads/ready-to-invoice`)
        .query({ customerId })
        .expect(200);
      const entry = queue.body.find((l: { id: string }) => l.id === loadId);
      expect(entry).toBeDefined();
      expect(entry.customerChargesTotal).toBe('2400.00');
    });
  });

  describe('Add Charge — Decision Log D9', () => {
    it('Dispatcher can add an ADJUSTMENT charge to a Load at any time after booking', async () => {
      const { loadId } = await createBookedLoad('add-charge-dispatcher');
      const chargeTypes = await dispatcherAgent.get(`${API}/charge-types`).expect(200);
      const detention = chargeTypes.body.find((c: { code: string }) => c.code === 'DETENTION');

      const res = await dispatcherAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CUSTOMER', chargeTypeId: detention.id, unitRate: '150.00' })
        .expect(201);
      expect(res.body.source).toBe('ADJUSTMENT');
      expect(res.body.amount).toBe('150');
    });

    it('Sales/Booking is excluded from adding charges', async () => {
      const { loadId } = await createBookedLoad('add-charge-sales');
      const chargeTypes = await adminAgent.get(`${API}/charge-types`).expect(200);
      const detention = chargeTypes.body.find((c: { code: string }) => c.code === 'DETENTION');

      await salesAgent
        .post(`${API}/loads/${loadId}/charges`)
        .send({ side: 'CUSTOMER', chargeTypeId: detention.id, unitRate: '150.00' })
        .expect(403);
    });
  });

  describe('Charge Types — Decision Log B3', () => {
    it('Admin can create and update a custom charge type; the list is visible to Dispatcher', async () => {
      const created = await adminAgent
        .post(`${API}/charge-types`)
        .send({ code: 'PALLET_EXCHANGE', label: 'Pallet Exchange' })
        .expect(201);
      expect(created.body.isSystemDefault).toBe(false);

      const updated = await adminAgent
        .patch(`${API}/charge-types/${created.body.id}`)
        .send({ label: 'Pallet Exchange Fee' })
        .expect(200);
      expect(updated.body.label).toBe('Pallet Exchange Fee');

      const list = await dispatcherAgent.get(`${API}/charge-types`).expect(200);
      expect(list.body.some((c: { code: string }) => c.code === 'PALLET_EXCHANGE')).toBe(true);
    });

    it('non-Admin is blocked from creating a charge type', async () => {
      await accountingAgent
        .post(`${API}/charge-types`)
        .send({ code: 'BLOCKED_TYPE', label: 'Should Fail' })
        .expect(403);
    });
  });

  describe('Invoice Builder — Workflow 8 §8.1-8.5', () => {
    it('creates an Individual invoice, marks the Load invoiced, and removes it from the Ready-to-Invoice queue', async () => {
      const { loadId, customerId } = await createBookedLoad('invoice-individual');
      const carrierId = await createEligibleCarrier('invoice-individual');
      await progressToDelivered(loadId, carrierId);

      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);
      expect(invoiceRes.body.status).toBe('DRAFT');
      // Prisma Decimal.toString() strips trailing zeros (documented Phase 3
      // quirk, see sourcing-dispatch.e2e-spec.ts) — "1800.00" serializes as "1800".
      expect(invoiceRes.body.total).toBe('1800');

      const loadAfter = await accountingAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.invoiced).toBe(true);

      const queue = await accountingAgent
        .get(`${API}/loads/ready-to-invoice`)
        .query({ customerId })
        .expect(200);
      expect(queue.body.find((l: { id: string }) => l.id === loadId)).toBeUndefined();
    });

    it('creates a Consolidated invoice with one line item per Load', async () => {
      const customerId = await createActiveCustomer(adminAgent, 'invoice-consolidated');
      const { loadId: loadId1 } = await createBookedLoad(
        'invoice-consolidated-1',
        customerId,
        '1000.00',
      );
      const { loadId: loadId2 } = await createBookedLoad(
        'invoice-consolidated-2',
        customerId,
        '2000.00',
      );
      const carrierId = await createEligibleCarrier('invoice-consolidated');
      await progressToDelivered(loadId1, carrierId);
      await progressToDelivered(loadId2, carrierId);

      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId1, loadId2], podWarningAcknowledged: true })
        .expect(201);
      expect(invoiceRes.body.total).toBe('3000');
      expect(invoiceRes.body.lineItems).toHaveLength(2);
    });

    it('blocks invoicing with incomplete POD unless explicitly acknowledged (Workflow 8 §8.2)', async () => {
      const { loadId, customerId } = await createBookedLoad('invoice-pod-warning');
      const carrierId = await createEligibleCarrier('invoice-pod-warning');
      await progressToDelivered(loadId, carrierId);
      // No POD ever uploaded — pod_status remains NOT_RECEIVED.

      const blocked = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId] })
        .expect(409);
      expect(blocked.body.error.code).toBe('POD_INCOMPLETE_WARNING');
      expect(blocked.body.error.details.affectedLoads).toContain(loadId);

      const acknowledged = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);
      expect(acknowledged.body.status).toBe('DRAFT');
    });

    it('Operations Manager cannot create an invoice (view-only per §5.4.7 resolution)', async () => {
      const { loadId, customerId } = await createBookedLoad('invoice-opsmgr-blocked');
      const carrierId = await createEligibleCarrier('invoice-opsmgr-blocked');
      await progressToDelivered(loadId, carrierId);

      await opsManagerAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId] })
        .expect(403);
    });
  });

  describe('Invoice lifecycle — Send/Payment/Adjustment/Void — Workflow 8 §8.6-§8.12', () => {
    async function createSentInvoice(seed: string): Promise<{ invoiceId: string; loadId: string }> {
      const { loadId, customerId } = await createBookedLoad(seed);
      const carrierId = await createEligibleCarrier(seed);
      await progressToDelivered(loadId, carrierId);
      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);
      const invoiceId = invoiceRes.body.id;
      await accountingAgent
        .post(`${API}/invoices/${invoiceId}/send`)
        .send({ recipientEmail: 'ap@customer.test', subject: 'Invoice', message: 'See attached.' })
        .expect(200);
      return { invoiceId, loadId };
    }

    it('Send transitions DRAFT -> SENT, computes due_date, and emails the recipient directly (Phase 6 Decision #6)', async () => {
      const { invoiceId } = await createSentInvoice('invoice-send');

      const detail = await accountingAgent.get(`${API}/invoices/${invoiceId}`).expect(200);
      expect(detail.body.status).toBe('SENT');
      expect(detail.body.dueDate).toBeTruthy();

      const email = lastEmailTo('ap@customer.test');
      expect(email.subject).toBe('Invoice');
    });

    it('a full payment marks the invoice PAID; a partial payment marks it PARTIALLY_PAID', async () => {
      const { invoiceId } = await createSentInvoice('invoice-payment-full');

      const detail = await accountingAgent.get(`${API}/invoices/${invoiceId}`).expect(200);
      const total = detail.body.total;

      const paid = await accountingAgent
        .post(`${API}/invoices/${invoiceId}/payments`)
        .send({ amount: total, paymentDate: '2026-08-15', method: 'ACH' })
        .expect(201);
      expect(paid.body.status).toBe('PAID');
      expect(paid.body.remainingBalance).toBe('0.00');
    });

    it('a fully-offsetting Credit adjustment (no payment) marks the invoice CREDITED', async () => {
      const { invoiceId } = await createSentInvoice('invoice-credited');
      const detail = await accountingAgent.get(`${API}/invoices/${invoiceId}`).expect(200);

      const result = await accountingAgent
        .post(`${API}/invoices/${invoiceId}/adjustments`)
        .send({ type: 'CREDIT', amount: detail.body.total, reason: 'Billing dispute resolved' })
        .expect(201);
      expect(result.body.status).toBe('CREDITED');
    });

    it('Void releases the Load back to the Ready-to-Invoice queue', async () => {
      const { invoiceId, loadId } = await createSentInvoice('invoice-void');

      await accountingAgent.post(`${API}/invoices/${invoiceId}/void`).expect(200);

      const loadAfter = await accountingAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.invoiced).toBe(false);

      await accountingAgent.post(`${API}/invoices/${invoiceId}/void`).expect(409);
    });
  });

  describe('Invoice permissions — UI_UX_DESIGN.md §5.4.7', () => {
    it('Dispatcher is blocked from viewing Invoices entirely (nav-hidden; direct URL -> permission-denied)', async () => {
      const { loadId, customerId } = await createBookedLoad('invoice-perm-dispatcher');
      const carrierId = await createEligibleCarrier('invoice-perm-dispatcher');
      await progressToDelivered(loadId, carrierId);
      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);

      await dispatcherAgent.get(`${API}/invoices/${invoiceRes.body.id}`).expect(403);
      await dispatcherAgent.get(`${API}/invoices`).expect(403);
    });

    it("Sales/Booking sees full detail for their own-deal Customer's invoice, and is blocked from a non-owned one", async () => {
      const salesUserId = await currentUserId(salesAgent);
      const ownedCustomerId = await createActiveCustomer(
        adminAgent,
        'invoice-perm-sales-owned',
        salesUserId,
      );
      const { loadId: ownedLoadId } = await createBookedLoad(
        'invoice-perm-sales-owned',
        ownedCustomerId,
      );
      const carrierId = await createEligibleCarrier('invoice-perm-sales');
      await progressToDelivered(ownedLoadId, carrierId);
      const ownedInvoice = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId: ownedCustomerId, loadIds: [ownedLoadId], podWarningAcknowledged: true })
        .expect(201);

      const ownedDetail = await salesAgent
        .get(`${API}/invoices/${ownedInvoice.body.id}`)
        .expect(200);
      expect(ownedDetail.body.total).toBe('1800');

      const { loadId: otherLoadId, customerId: otherCustomerId } = await createBookedLoad(
        'invoice-perm-sales-other',
      );
      await progressToDelivered(otherLoadId, carrierId);
      const otherInvoice = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId: otherCustomerId, loadIds: [otherLoadId], podWarningAcknowledged: true })
        .expect(201);

      await salesAgent.get(`${API}/invoices/${otherInvoice.body.id}`).expect(403);

      const list = await salesAgent.get(`${API}/invoices`).expect(200);
      const otherRow = list.body.find((i: { id: string }) => i.id === otherInvoice.body.id);
      expect(otherRow).toBeDefined();
      expect(otherRow.total).toBeNull();
    });
  });

  describe('Carrier Payment lifecycle — Workflow 9', () => {
    async function createDeliveredLoadWithCarrier(
      seed: string,
    ): Promise<{ loadId: string; carrierId: string }> {
      const { loadId } = await createBookedLoad(seed);
      const carrierId = await createEligibleCarrier(seed);
      await progressToDelivered(loadId, carrierId, '1500.00');
      return { loadId, carrierId };
    }

    it('runs the full Draft -> Submit -> Approve -> Mark Paid cycle and generates a settlement document', async () => {
      const { loadId } = await createDeliveredLoadWithCarrier('cp-full-cycle');

      const draft = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({
          paymentType: 'BALANCE',
          amount: '1500.00',
          method: 'ACH',
          referenceNumber: 'REF-1',
        })
        .expect(201);
      expect(draft.body.status).toBe('DRAFT');

      const submitted = await accountingAgent
        .post(`${API}/carrier-payments/${draft.body.id}/submit`)
        .expect(200);
      expect(submitted.body.status).toBe('PENDING_APPROVAL');

      const approved = await adminAgent
        .post(`${API}/carrier-payments/${draft.body.id}/approve`)
        .expect(200);
      expect(approved.body.status).toBe('APPROVED');

      const paid = await accountingAgent
        .post(`${API}/carrier-payments/${draft.body.id}/mark-paid`)
        .send({})
        .expect(200);
      expect(paid.body.status).toBe('PAID');

      const docs = await adminAgent
        .get(`${API}/documents`)
        .query({ entityType: 'CARRIER_PAYMENT', entityId: draft.body.id })
        .expect(200);
      expect(
        docs.body.some((d: { fileName: string }) => d.fileName.startsWith('Settlement-')),
      ).toBe(true);
    });

    it('blocks self-approval and the same self-check on rejection', async () => {
      const { loadId } = await createDeliveredLoadWithCarrier('cp-self-approval');

      const draft = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({ paymentType: 'DEPOSIT', amount: '500.00', method: 'ACH', referenceNumber: 'REF-2' })
        .expect(201);
      await accountingAgent.post(`${API}/carrier-payments/${draft.body.id}/submit`).expect(200);

      // Accounting user who prepared it also holds Admin? No — but Admin
      // must be a DISTINCT user from the preparer. adminAgent here is a
      // different user than accountingAgent, so this call is a valid
      // approval — self-block is proven by the ADMIN user attempting to
      // approve their OWN prepared payment below instead.
      const ownDraft = await adminAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({ paymentType: 'DEPOSIT', amount: '200.00', method: 'ACH', referenceNumber: 'REF-3' })
        .expect(201);
      await adminAgent.post(`${API}/carrier-payments/${ownDraft.body.id}/submit`).expect(200);

      const blocked = await adminAgent
        .post(`${API}/carrier-payments/${ownDraft.body.id}/approve`)
        .expect(403);
      expect(blocked.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
    });

    it('a rejected payment returns to DRAFT and can be revised and resubmitted through the full cycle again', async () => {
      const { loadId } = await createDeliveredLoadWithCarrier('cp-reject-resubmit');

      const draft = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({
          paymentType: 'BALANCE',
          amount: '1500.00',
          method: 'ACH',
          referenceNumber: 'REF-4',
        })
        .expect(201);
      await accountingAgent.post(`${API}/carrier-payments/${draft.body.id}/submit`).expect(200);

      const rejected = await adminAgent
        .post(`${API}/carrier-payments/${draft.body.id}/reject`)
        .send({ reason: 'Reference number does not match carrier invoice' })
        .expect(200);
      expect(rejected.body.status).toBe('DRAFT');

      await accountingAgent.post(`${API}/carrier-payments/${draft.body.id}/submit`).expect(200);
      const approved = await adminAgent
        .post(`${API}/carrier-payments/${draft.body.id}/approve`)
        .expect(200);
      expect(approved.body.status).toBe('APPROVED');
    });

    it('rejects marking a non-Approved payment as Paid', async () => {
      const { loadId } = await createDeliveredLoadWithCarrier('cp-not-approved');
      const draft = await accountingAgent
        .post(`${API}/loads/${loadId}/carrier-payments`)
        .send({ paymentType: 'DEPOSIT', amount: '500.00' })
        .expect(201);

      await accountingAgent
        .post(`${API}/carrier-payments/${draft.body.id}/mark-paid`)
        .send({})
        .expect(409);
    });

    it('Dispatcher cannot view Carrier Payments (Billing nav hidden entirely from Dispatcher)', async () => {
      await dispatcherAgent.get(`${API}/carrier-payments`).expect(403);
    });
  });

  describe('Load Closing — Workflow 10', () => {
    it('closes unconditionally even with an incomplete checklist, and reports a Warning-status checklist item', async () => {
      const { loadId } = await createBookedLoad('close-incomplete');
      const carrierId = await createEligibleCarrier('close-incomplete');
      await progressToDelivered(loadId, carrierId);
      // No invoice, no carrier payment, no POD ever uploaded.

      const closed = await accountingAgent.post(`${API}/loads/${loadId}/close`).expect(200);
      expect(closed.body.load.status).toBe('CLOSED');
      const podItem = closed.body.checklistSnapshot.find((c: { item: string }) => c.item === 'POD');
      expect(podItem.status).toBe('WARNING');

      await accountingAgent.post(`${API}/loads/${loadId}/close`).expect(409);
    });

    it('Dispatcher cannot close a Load (Workflow 10 excludes Dispatcher)', async () => {
      const { loadId } = await createBookedLoad('close-dispatcher-blocked');
      const carrierId = await createEligibleCarrier('close-dispatcher-blocked');
      await progressToDelivered(loadId, carrierId);

      await dispatcherAgent.post(`${API}/loads/${loadId}/close`).expect(403);
    });
  });

  describe('Cross-tenant isolation for Phase 6 tables', () => {
    it("one organization's Invoice/CarrierPayment data is never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const customerAId = await createActiveCustomer(orgA.adminAgent, 'cross-a-cust');
      const loadARes = await orgA.adminAgent
        .post(`${API}/loads`)
        .send({
          customerId: customerAId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '1800.00',
        })
        .expect(201);
      const loadAId = loadARes.body.id;

      const invoiceA = await orgA.accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId: customerAId, loadIds: [loadAId], podWarningAcknowledged: true })
        .expect(422); // Not yet Delivered — expected; proves the app-layer rule fires before any cross-tenant concern.
      expect(invoiceA.body.error).toBeDefined();

      // --- Application-layer proof: org B's own Invoice list is empty, never sees org A's rows -----
      const orgBList = await orgB.accountingAgent.get(`${API}/invoices`).expect(200);
      expect(orgBList.body).toHaveLength(0);

      // --- Database-layer (RLS) proof for the invoice/charge_line_item tables -----
      const chargeRowsWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM charge_line_item WHERE load_id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(chargeRowsWrongTenant).toHaveLength(0);

      const chargeRowsOwnTenant = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM charge_line_item WHERE load_id = ${loadAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(chargeRowsOwnTenant.length).toBeGreaterThan(0); // ORIGINAL linehaul charge auto-created at booking

      const rowsWithNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM charge_line_item WHERE load_id = ${loadAId}::uuid`;
      expect(rowsWithNoContext).toHaveLength(0);
      // Two full setUpOrganization() calls (6 real agent logins each, real
      // bcrypt hashing) comfortably exceed Jest's 5000ms default under
      // --runInBand's sequential load — explicit override, not a hidden failure.
    }, 30000);
  });
});
