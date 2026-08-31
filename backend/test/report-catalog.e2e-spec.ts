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

const STOPS_WITH_APPOINTMENTS = (pickupIso: string, deliveryIso: string) => [
  {
    sequence: 1,
    stopType: 'PICKUP',
    companyName: 'Test Co',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
    appointmentDatetime: pickupIso,
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    companyName: 'Test Co',
    addressLine1: '2 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
    appointmentDatetime: deliveryIso,
  },
];

const PLAIN_STOPS = [
  {
    sequence: 1,
    stopType: 'PICKUP',
    companyName: 'Test Co',
    addressLine1: '1 Dock Rd',
    city: 'Dallas',
    state: 'TX',
    zip: '75201',
  },
  {
    sequence: 2,
    stopType: 'DELIVERY',
    companyName: 'Test Co',
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
 * Phase 21 (Reports Library) end-to-end proof — the 8 new catalog reports
 * plus the role-aware `GET /reports/catalog` listing and AR/AP Aging's new
 * `/export` routes. Exercises the real raw-SQL rollups (Revenue & Margin's
 * 4 groupings, On-Time Performance) against a live Postgres instance —
 * unit tests mock `$queryRaw`, so this file is the only place the SQL
 * itself is actually proven correct.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Reports Library (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'report-catalog-suite-super-admin@trucktms.internal';
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
        name: 'Report Catalog Suite Platform Super Admin',
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
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
    accountingAgent = org.accountingAgent;
    opsManagerAgent = org.opsManagerAgent;
    reviewerAgent = org.reviewerAgent;
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

    const adminEmail = `admin-${seed}@report-catalog-test.test`;
    const salesEmail = `sales-${seed}@report-catalog-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@report-catalog-test.test`;
    const accountingEmail = `accounting-${seed}@report-catalog-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@report-catalog-test.test`;
    const reviewerEmail = `reviewer-${seed}@report-catalog-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Report Catalog Test Org ${seed}`,
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
        legalName: `Report Catalog Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@report-catalog-customer.test`,
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
    await fetch(initiateRes.body.uploadUrl, {
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
        mcNumber: `MC-RC-${seed}`,
        dotNumber: `DOT-RC-${seed}`,
        addressLine1: '5 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        primaryContactName: 'Carrier Dispatch',
        primaryContactPhone: '555-0300',
        primaryContactEmail: `dispatch-${seed}@report-catalog-carrier.test`,
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
    const mcId = await uploadAndConfirm(adminAgent, carrierId, mcAuthorityTypeId, 'mc.pdf');
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
    stops: unknown[] = PLAIN_STOPS,
  ): Promise<{ loadId: string; customerId: string; loadNumber: string }> {
    const custId = customerId ?? (await createActiveCustomer(adminAgent, seed));
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId: custId, stops, equipmentType: 'DRY_VAN', customerRate })
      .expect(201);
    return { loadId: res.body.id, customerId: custId, loadNumber: res.body.loadNumber };
  }

  async function assignAndDispatch(
    loadId: string,
    carrierId: string,
    dispatcherUserId: string,
    carrierRate = '1500.00',
  ): Promise<void> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/dispatch`).send(DISPATCH_BODY).expect(200);
    await adminAgent
      .patch(`${API}/loads/${loadId}/dispatcher`)
      .send({ dispatcherUserId })
      .expect(200);
  }

  /** Departure must never precede its own stop's arrival — when a custom arrival is given, departure gets arrival+1h explicitly rather than defaulting to `now()`. */
  function plusOneHour(iso: string): string {
    return new Date(new Date(iso).getTime() + 60 * 60 * 1000).toISOString();
  }

  async function deliverStops(
    loadId: string,
    arrivalTimestamps?: { pickup?: string; delivery?: string },
  ) {
    await adminAgent
      .post(`${API}/loads/${loadId}/stops/1/arrival`)
      .send(arrivalTimestamps?.pickup ? { timestamp: arrivalTimestamps.pickup } : {})
      .expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/stops/1/departure`)
      .send(arrivalTimestamps?.pickup ? { timestamp: plusOneHour(arrivalTimestamps.pickup) } : {})
      .expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/stops/2/arrival`)
      .send(arrivalTimestamps?.delivery ? { timestamp: arrivalTimestamps.delivery } : {})
      .expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/stops/2/departure`)
      .send(
        arrivalTimestamps?.delivery ? { timestamp: plusOneHour(arrivalTimestamps.delivery) } : {},
      )
      .expect(200);
  }

  async function currentUserId(agent: SuperAgentTest): Promise<string> {
    const res = await agent.get(`${API}/auth/me`).expect(200);
    return res.body.id;
  }

  async function addCharge(
    loadId: string,
    side: 'CUSTOMER' | 'CARRIER',
    amount: string,
    chargeTypeCode = 'LINEHAUL',
  ): Promise<void> {
    const types = await adminAgent.get(`${API}/charge-types`).expect(200);
    const chargeType = types.body.find((c: { code: string }) => c.code === chargeTypeCode);
    await adminAgent
      .post(`${API}/loads/${loadId}/charges`)
      .send({ side, chargeTypeId: chargeType.id, unitRate: amount, quantity: '1' })
      .expect(201);
  }

  describe('GET /reports/catalog', () => {
    it('Admin and Operations Manager see all 5 categories', async () => {
      for (const agent of [adminAgent, opsManagerAgent]) {
        const res = await agent.get(`${API}/reports/catalog`).expect(200);
        const keys = res.body.categories.map((c: { key: string }) => c.key);
        expect(keys).toEqual(
          expect.arrayContaining([
            'AR_AP',
            'FINANCIAL',
            'OPERATIONS',
            'CARRIER_PERFORMANCE',
            'SALES',
          ]),
        );
      }
    });

    it('Dispatcher sees only Operations and Carrier Performance', async () => {
      const res = await dispatcherAgent.get(`${API}/reports/catalog`).expect(200);
      const keys = res.body.categories.map((c: { key: string }) => c.key);
      expect(keys).toEqual(['OPERATIONS', 'CARRIER_PERFORMANCE']);
    });

    it('Sales/Booking sees only Sales', async () => {
      const res = await salesAgent.get(`${API}/reports/catalog`).expect(200);
      expect(res.body.categories.map((c: { key: string }) => c.key)).toEqual(['SALES']);
    });

    it('Accounting sees AR/AP, Financial, and Carrier Performance', async () => {
      const res = await accountingAgent.get(`${API}/reports/catalog`).expect(200);
      expect(res.body.categories.map((c: { key: string }) => c.key)).toEqual([
        'AR_AP',
        'FINANCIAL',
        'CARRIER_PERFORMANCE',
      ]);
    });

    it('Compliance Reviewer (no base role) sees nothing', async () => {
      const res = await reviewerAgent.get(`${API}/reports/catalog`).expect(200);
      expect(res.body.categories).toEqual([]);
    });
  });

  describe('GET /reports/payment-history', () => {
    it('requires dateFrom and dateTo — 400 without them', async () => {
      await accountingAgent.get(`${API}/reports/payment-history`).expect(400);
    });

    it('Dispatcher and Sales/Booking are denied; Accounting sees a real Payment row', async () => {
      const { loadId, customerId } = await createBookedLoad('ph-1');
      const carrierId = await createEligibleCarrier('ph-1');
      await assignAndDispatch(loadId, carrierId, await currentUserId(adminAgent));
      await deliverStops(loadId);
      const invoiceRes = await accountingAgent
        .post(`${API}/invoices`)
        .send({ customerId, loadIds: [loadId], podWarningAcknowledged: true })
        .expect(201);
      await accountingAgent
        .post(`${API}/invoices/${invoiceRes.body.id}/send`)
        .send({ recipientEmail: 'ap@customer.test', subject: 'Invoice', message: 'See attached.' })
        .expect(200);
      const total = (await accountingAgent.get(`${API}/invoices/${invoiceRes.body.id}`).expect(200))
        .body.total;
      await accountingAgent
        .post(`${API}/invoices/${invoiceRes.body.id}/payments`)
        .send({ amount: total, paymentDate: '2026-06-15', method: 'ACH' })
        .expect(201);

      await dispatcherAgent
        .get(`${API}/reports/payment-history`)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
        .expect(403);
      await salesAgent
        .get(`${API}/reports/payment-history`)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
        .expect(403);

      const res = await accountingAgent
        .get(`${API}/reports/payment-history`)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
        .expect(200);
      const row = res.body.items.find((r: { type: string }) => r.type === 'PAYMENT');
      expect(row).toBeDefined();
      expect(Number(row.amount)).toBe(Number(total));
      expect(row.method).toBe('ACH');
    });

    it('export CSV matches on-screen filters/authorization', async () => {
      const res = await accountingAgent
        .get(`${API}/reports/payment-history/export`)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.split('\r\n')[0]).toBe(
        'Date,Type,Invoice #,Customer,Amount,Method,Adjustment Type,Reference #,Reason,Recorded By',
      );
      await dispatcherAgent
        .get(`${API}/reports/payment-history/export`)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
        .expect(403);
    });
  });

  describe('GET /reports/revenue-margin', () => {
    it('rejects an invalid groupBy with 400', async () => {
      await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'BOGUS' })
        .expect(400);
    });

    it('Dispatcher and Sales/Booking are denied; Admin/OpsManager/Accounting allowed', async () => {
      await dispatcherAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'CUSTOMER' })
        .expect(403);
      await salesAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'CUSTOMER' })
        .expect(403);
      for (const agent of [adminAgent, opsManagerAgent, accountingAgent]) {
        await agent.get(`${API}/reports/revenue-margin`).query({ groupBy: 'CUSTOMER' }).expect(200);
      }
    });

    it('groupBy=CUSTOMER computes exact Revenue/Cost/GP/Margin% per DATABASE_DESIGN §20', async () => {
      const { loadId, customerId } = await createBookedLoad('rm-customer', undefined, '0.00');
      const carrierId = await createEligibleCarrier('rm-customer');
      // carrierRate=0.00 avoids assign-carrier's own auto-created carrier-side
      // LINEHAUL charge (DATABASE_DESIGN.md §14) from muddying the expected cost.
      await assignAndDispatch(loadId, carrierId, await currentUserId(adminAgent), '0.00');
      await addCharge(loadId, 'CUSTOMER', '1000.00');
      await addCharge(loadId, 'CARRIER', '600.00');

      const res = await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'CUSTOMER', customerId, pageSize: 100 })
        .expect(200);
      const row = res.body.items.find((r: { groupKey: string }) => r.groupKey === customerId);
      expect(row).toBeDefined();
      expect(row.revenue).toBe('1000.00');
      expect(row.cost).toBe('600.00');
      expect(row.grossProfit).toBe('400.00');
      expect(row.marginPercent).toBe('40.00');
    });

    it('groupBy=CARRIER, MONTH, and LANE each return without error and reflect the same underlying load', async () => {
      const { loadId, customerId } = await createBookedLoad('rm-multi', undefined, '0.00');
      const carrierId = await createEligibleCarrier('rm-multi');
      await assignAndDispatch(loadId, carrierId, await currentUserId(adminAgent), '0.00');
      await addCharge(loadId, 'CUSTOMER', '800.00');
      await addCharge(loadId, 'CARRIER', '500.00');

      const carrierRes = await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'CARRIER', carrierId, pageSize: 100 })
        .expect(200);
      const carrierRow = carrierRes.body.items.find(
        (r: { groupKey: string }) => r.groupKey === carrierId,
      );
      expect(carrierRow.revenue).toBe('800.00');
      expect(carrierRow.cost).toBe('500.00');

      const monthRes = await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'MONTH', customerId, pageSize: 100 })
        .expect(200);
      expect(
        monthRes.body.items.reduce(
          (sum: number, r: { revenue: string }) => sum + Number(r.revenue),
          0,
        ),
      ).toBeGreaterThanOrEqual(800);

      const laneRes = await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'LANE', customerId, pageSize: 100 })
        .expect(200);
      const laneRow = laneRes.body.items.find((r: { groupLabel: string }) =>
        r.groupLabel.includes('Dallas'),
      );
      expect(laneRow).toBeDefined();
      expect(laneRow.groupLabel).toContain('Chicago');
    });

    it('compare=true returns a previousPeriod computed from the shifted range', async () => {
      const res = await accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'MONTH', dateFrom: '2026-06-01', dateTo: '2026-06-30', compare: 'true' })
        .expect(200);
      expect(res.body.previousPeriod).toBeDefined();
    });

    it('export CSV shares the same role gate and filters as the JSON route', async () => {
      await dispatcherAgent
        .get(`${API}/reports/revenue-margin/export`)
        .query({ groupBy: 'CUSTOMER' })
        .expect(403);
      const res = await accountingAgent
        .get(`${API}/reports/revenue-margin/export`)
        .query({ groupBy: 'CUSTOMER' })
        .expect(200);
      expect(res.text.split('\r\n')[0]).toBe('Group,Load Count,Revenue,Cost,Gross Profit,Margin %');
    });
  });

  describe('Operations reports — Load Volume / Status Mix / Dispatcher Workload', () => {
    it('Admin/OpsManager/Dispatcher allowed; Sales/Booking and Accounting denied', async () => {
      for (const agent of [adminAgent, opsManagerAgent, dispatcherAgent]) {
        await agent.get(`${API}/reports/load-volume`).expect(200);
        await agent.get(`${API}/reports/status-mix`).expect(200);
        await agent.get(`${API}/reports/dispatcher-workload`).expect(200);
      }
      for (const agent of [salesAgent, accountingAgent]) {
        await agent.get(`${API}/reports/load-volume`).expect(403);
        await agent.get(`${API}/reports/status-mix`).expect(403);
        await agent.get(`${API}/reports/dispatcher-workload`).expect(403);
      }
    });

    it('load-volume rejects an invalid bucket', async () => {
      await dispatcherAgent.get(`${API}/reports/load-volume`).query({ bucket: 'YEAR' }).expect(400);
    });

    it('status-mix percentages sum to 100 and reflect a real Load', async () => {
      await createBookedLoad('sm-1');
      const res = await dispatcherAgent.get(`${API}/reports/status-mix`).expect(200);
      const total = res.body.reduce(
        (sum: number, r: { percentOfTotal: string }) => sum + Number(r.percentOfTotal),
        0,
      );
      expect(Math.round(total)).toBe(100);
    });

    it('dispatcher-workload attributes a Load to the assigned dispatcher', async () => {
      const dispatcherId = await currentUserId(dispatcherAgent);
      const { loadId } = await createBookedLoad('dw-1');
      const carrierId = await createEligibleCarrier('dw-1');
      await assignAndDispatch(loadId, carrierId, dispatcherId);

      const res = await adminAgent
        .get(`${API}/reports/dispatcher-workload`)
        .query({ pageSize: 100 })
        .expect(200);
      const row = res.body.items.find(
        (r: { dispatcherId: string }) => r.dispatcherId === dispatcherId,
      );
      expect(row).toBeDefined();
      expect(row.loadsAssigned).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /reports/on-time-performance', () => {
    it('rejects an invalid groupBy', async () => {
      await dispatcherAgent
        .get(`${API}/reports/on-time-performance`)
        .query({ groupBy: 'LOAD' })
        .expect(400);
    });

    it('computes on-time correctly (arrival <= appointment) and excludes null-appointment deliveries', async () => {
      const carrierId = await createEligibleCarrier('otp-1');
      const dispatcherId = await currentUserId(dispatcherAgent);

      // Appointment/arrival timestamps must be in the future relative to
      // "now" (dispatch just happened) — arrival cannot precede dispatch.
      const addDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const pickupAppt = addDays(5).toISOString();
      const deliveryAppt = addDays(7).toISOString();
      const onTimeArrival = addDays(6.9).toISOString(); // before the delivery appointment
      const lateArrival = addDays(7.2).toISOString(); // after the delivery appointment

      const { loadId: onTimeLoadId } = await createBookedLoad(
        'otp-ontime',
        undefined,
        '1800.00',
        STOPS_WITH_APPOINTMENTS(pickupAppt, deliveryAppt),
      );
      await assignAndDispatch(onTimeLoadId, carrierId, dispatcherId);
      await deliverStops(onTimeLoadId, { pickup: pickupAppt, delivery: onTimeArrival });

      const { loadId: lateLoadId } = await createBookedLoad(
        'otp-late',
        undefined,
        '1800.00',
        STOPS_WITH_APPOINTMENTS(pickupAppt, deliveryAppt),
      );
      await assignAndDispatch(lateLoadId, carrierId, dispatcherId);
      await deliverStops(lateLoadId, { pickup: pickupAppt, delivery: lateArrival });

      // No-appointment delivery: excluded from the denominator.
      const { loadId: noAppointmentLoadId } = await createBookedLoad('otp-noappt');
      await assignAndDispatch(noAppointmentLoadId, carrierId, dispatcherId);
      await deliverStops(noAppointmentLoadId);

      const res = await dispatcherAgent
        .get(`${API}/reports/on-time-performance`)
        .query({
          groupBy: 'CARRIER',
          dateFrom: addDays(1).toISOString(),
          dateTo: addDays(30).toISOString(),
          pageSize: 100,
        })
        .expect(200);
      const row = res.body.items.find((r: { groupKey: string }) => r.groupKey === carrierId);
      expect(row.deliveriesEvaluated).toBe(2);
      expect(row.onTimeCount).toBe(1);
      expect(row.onTimePercent).toBe('50.00');
    });
  });

  describe('GET /reports/carrier-performance — cost redaction (approved decision)', () => {
    it('role matrix: Sales/Booking denied; Admin/OpsManager/Dispatcher/Accounting allowed', async () => {
      await salesAgent.get(`${API}/reports/carrier-performance`).expect(403);
      for (const agent of [adminAgent, opsManagerAgent, dispatcherAgent, accountingAgent]) {
        await agent.get(`${API}/reports/carrier-performance`).expect(200);
      }
    });

    it('Admin sees totalCost/avgCostPerLoad; Dispatcher sees the same operational numbers with cost redacted to null', async () => {
      const { loadId } = await createBookedLoad('cp-1', undefined, '0.00');
      const carrierId = await createEligibleCarrier('cp-1');
      await assignAndDispatch(loadId, carrierId, await currentUserId(adminAgent), '0.00');
      await addCharge(loadId, 'CARRIER', '700.00');

      const adminRes = await adminAgent
        .get(`${API}/reports/carrier-performance`)
        .query({ pageSize: 100 })
        .expect(200);
      const adminRow = adminRes.body.items.find(
        (r: { carrierId: string }) => r.carrierId === carrierId,
      );
      expect(adminRow.totalCost).toBe('700.00');
      expect(adminRow.avgCostPerLoad).toBe('700.00');
      expect(adminRow.loadCount).toBeGreaterThanOrEqual(1);

      const dispatcherRes = await dispatcherAgent
        .get(`${API}/reports/carrier-performance`)
        .query({ pageSize: 100 })
        .expect(200);
      const dispatcherRow = dispatcherRes.body.items.find(
        (r: { carrierId: string }) => r.carrierId === carrierId,
      );
      expect(dispatcherRow.loadCount).toBe(adminRow.loadCount);
      expect(dispatcherRow.totalCost).toBeNull();
      expect(dispatcherRow.avgCostPerLoad).toBeNull();
    });

    it('export CSV redacts cost for Dispatcher identically to the JSON route', async () => {
      const res = await dispatcherAgent
        .get(`${API}/reports/carrier-performance/export`)
        .expect(200);
      const lines = res.text.trim().split('\r\n');
      for (const line of lines.slice(1)) {
        expect(line.endsWith(',,')).toBe(true);
      }
    });
  });

  describe('GET /reports/sales-performance — own-row scoping and GP redaction (approved decision)', () => {
    it('role matrix: Dispatcher and Accounting denied; Admin/OpsManager/Sales-Booking allowed', async () => {
      await dispatcherAgent.get(`${API}/reports/sales-performance`).expect(403);
      await accountingAgent.get(`${API}/reports/sales-performance`).expect(403);
      for (const agent of [adminAgent, opsManagerAgent, salesAgent]) {
        await agent.get(`${API}/reports/sales-performance`).expect(200);
      }
    });

    it("Admin sees every rep's Gross Profit; Sales/Booking sees only their own row with Gross Profit nulled", async () => {
      const salesUserId = await currentUserId(salesAgent);
      const ownedCustomerId = await createActiveCustomer(adminAgent, 'sp-owned', salesUserId);
      // The load must be *created by* the Sales/Booking user (Load.createdByUserId
      // is the "sales user" rollup dimension) — createBookedLoad always posts as
      // adminAgent, so this one is booked directly by salesAgent instead.
      const bookedRes = await salesAgent
        .post(`${API}/loads`)
        .send({
          customerId: ownedCustomerId,
          stops: PLAIN_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '0.00',
        })
        .expect(201);
      const loadId: string = bookedRes.body.id;
      const carrierId = await createEligibleCarrier('sp-owned');
      await assignAndDispatch(loadId, carrierId, await currentUserId(adminAgent), '0.00');
      await addCharge(loadId, 'CUSTOMER', '900.00');
      await addCharge(loadId, 'CARRIER', '400.00');

      const otherLoadId = (await createBookedLoad('sp-other')).loadId;
      const otherCarrierId = await createEligibleCarrier('sp-other');
      await assignAndDispatch(otherLoadId, otherCarrierId, await currentUserId(adminAgent));

      const adminRes = await adminAgent
        .get(`${API}/reports/sales-performance`)
        .query({ pageSize: 100 })
        .expect(200);
      const adminRow = adminRes.body.items.find(
        (r: { repUserId: string }) => r.repUserId === salesUserId,
      );
      expect(adminRow).toBeDefined();
      expect(adminRow.grossProfit).toBe('500.00');
      expect(adminRes.body.items.length).toBeGreaterThanOrEqual(2);

      const salesRes = await salesAgent
        .get(`${API}/reports/sales-performance`)
        .query({ pageSize: 100 })
        .expect(200);
      expect(salesRes.body.items).toHaveLength(1);
      expect(salesRes.body.items[0].repUserId).toBe(salesUserId);
      expect(salesRes.body.items[0].revenue).toBe('900.00');
      expect(salesRes.body.items[0].grossProfit).toBeNull();
    });
  });

  describe('AR/AP Aging export (Phase 21 addition)', () => {
    it('AR Aging export CSV matches the JSON bucket data and shares the same role gate', async () => {
      await dispatcherAgent.get(`${API}/reports/ar-aging/export`).expect(403);
      const json = await accountingAgent.get(`${API}/reports/ar-aging`).expect(200);
      const csv = await accountingAgent.get(`${API}/reports/ar-aging/export`).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const lines = csv.text.trim().split('\r\n');
      expect(lines[0]).toBe('Bucket,Items,Total');
      expect(lines[lines.length - 1]).toBe(`Grand Total,,${json.body.grandTotal}`);
    });

    it('AP Aging export CSV matches the JSON bucket data', async () => {
      await dispatcherAgent.get(`${API}/reports/ap-aging/export`).expect(403);
      const json = await accountingAgent.get(`${API}/reports/ap-aging`).expect(200);
      const csv = await accountingAgent.get(`${API}/reports/ap-aging/export`).expect(200);
      const lines = csv.text.trim().split('\r\n');
      expect(lines[lines.length - 1]).toBe(`Grand Total,,${json.body.grandTotal}`);
    });
  });

  describe('Cross-tenant isolation', () => {
    it("Revenue & Margin, Carrier Performance, and Sales Performance never surface another organization's data", async () => {
      const orgB = await setUpOrganization('cross-b');

      const revRes = await orgB.accountingAgent
        .get(`${API}/reports/revenue-margin`)
        .query({ groupBy: 'CUSTOMER', pageSize: 200 })
        .expect(200);
      expect(revRes.body.total).toBe(0);

      const carrierRes = await orgB.adminAgent
        .get(`${API}/reports/carrier-performance`)
        .query({ pageSize: 200 })
        .expect(200);
      expect(carrierRes.body.total).toBe(0);

      const salesRes = await orgB.adminAgent
        .get(`${API}/reports/sales-performance`)
        .query({ pageSize: 200 })
        .expect(200);
      expect(salesRes.body.total).toBe(0);
    }, 30000);
  });
});
