import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

/** Every route except /health sits behind the global prefix (main.ts / configure-app.ts). */
const API = '/api/v1';

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

const LOAD_STOPS = [
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

/**
 * Phase 3 (Load Lifecycle Core) end-to-end proof: Workflow 4's two entry
 * paths (Quote creation + Direct-to-Booked), Customer-status gating across
 * both the Quote and Booking columns, Rate Agreement matching, Quote
 * Won/Lost handling, Quote-to-Load conversion, independent Quote/Load
 * numbering, reference numbers, the dispatcher-handoff boundary,
 * role-based permissions/financial-field visibility, and cross-tenant RLS
 * isolation for the new tables — run against a live app instance with a
 * live PostgreSQL + Redis.
 *
 * Requires the same setup as test/core-master-data.e2e-spec.ts:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Load Lifecycle Core (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  // Distinct from every other e2e spec's own super-admin fixture email —
  // e2e spec files run in parallel workers against the same live shared
  // database, so an identical literal here would race another file's
  // beforeAll for the same unique email.
  const superAdminEmail = 'load-lifecycle-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;

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
        name: 'Load Lifecycle Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const org = await setUpOrganization('main');
    adminAgent = org.adminAgent;
    salesAgent = org.salesAgent;
    dispatcherAgent = org.dispatcherAgent;
    accountingAgent = org.accountingAgent;
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

  /**
   * `seed` must be unique per call within this file, per the same
   * multi-org identity-reuse reasoning documented in
   * core-master-data.e2e-spec.ts's own setUpOrganization.
   */
  async function setUpOrganization(seed: string) {
    const superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@load-lifecycle-test.test`;
    const salesEmail = `sales-${seed}@load-lifecycle-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@load-lifecycle-test.test`;
    const accountingEmail = `accounting-${seed}@load-lifecycle-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Load Lifecycle Test Org ${seed}`,
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

    const adminAgent = await activateAndLogin(adminEmail, 'OrgAdminPass123');

    await adminAgent
      .post(`${API}/memberships/invite`)
      .send({ email: salesEmail, roles: ['SALES_BOOKING'] })
      .expect(201);
    const salesAgent = await activateAndLogin(salesEmail, 'SalesPass123');

    await adminAgent
      .post(`${API}/memberships/invite`)
      .send({ email: dispatcherEmail, roles: ['DISPATCHER'] })
      .expect(201);
    const dispatcherAgent = await activateAndLogin(dispatcherEmail, 'DispatcherPass123');

    await adminAgent
      .post(`${API}/memberships/invite`)
      .send({ email: accountingEmail, roles: ['ACCOUNTING'] })
      .expect(201);
    const accountingAgent = await activateAndLogin(accountingEmail, 'AccountingPass123');

    return { organizationId: newOrgId, adminAgent, salesAgent, dispatcherAgent, accountingAgent };
  }

  async function createCustomer(
    agent: SuperAgentTest,
    status: 'PROSPECT' | 'ACTIVE' | 'INACTIVE' | 'BLOCKED',
    seed: string,
  ): Promise<string> {
    // acknowledgeDuplicates: true — every test customer in this file
    // shares the same billing address, which alone triggers Workflow 2
    // §2.2's duplicate-detection warning (legalName OR billingAddress OR
    // email match) on the 2nd+ customer created within the same org.
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@load-lifecycle-customer.test`,
        primaryContactPhone: '555-0200',
        acknowledgeDuplicates: true,
      })
      .expect(201);
    const customerId: string = res.body.id;
    if (status !== 'PROSPECT') {
      await agent.post(`${API}/customers/${customerId}/status`).send({ status }).expect(200);
    }
    return customerId;
  }

  describe('Quote creation — Workflow 4 §4.2/§4.3', () => {
    it('creates a Quote at status OPEN with a generated number for an Active customer', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'quote-active');
      const res = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '2450.00' })
        .expect(201);
      expect(res.body.status).toBe('OPEN');
      expect(res.body.quoteNumber).toMatch(/^QUOTE-\d{6}$/);
    });

    it('allows Quote creation for a Prospect customer', async () => {
      const customerId = await createCustomer(adminAgent, 'PROSPECT', 'quote-prospect');
      await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
    });

    it('allows Quote creation for an Inactive customer — warning only, no override required', async () => {
      const customerId = await createCustomer(adminAgent, 'INACTIVE', 'quote-inactive');
      await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
    });

    it('blocks Quote creation for a Blocked customer', async () => {
      const customerId = await createCustomer(adminAgent, 'BLOCKED', 'quote-blocked');
      await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(422);
    });

    it('rejects a Quote with no pickup or no delivery stop', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'quote-bad-stops');
      await adminAgent
        .post(`${API}/quotes`)
        .send({
          customerId,
          stops: [QUOTE_STOPS[0]],
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(422);
    });
  });

  describe('Rate Agreement matching — Workflow 4 §4.4', () => {
    it('matches an active Rate Agreement and sets rateSource=RATE_AGREEMENT when accepted as-is', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'rate-match');
      await adminAgent
        .post(`${API}/customers/${customerId}/rate-agreements`)
        .send({
          originCity: 'Dallas',
          originState: 'TX',
          destinationCity: 'Chicago',
          destinationState: 'IL',
          equipmentType: 'DRY_VAN',
          rate: '2450.00',
          rateType: 'FLAT',
          effectiveDate: '2020-01-01',
        })
        .expect(201);

      const res = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '2450.00' })
        .expect(201);
      expect(res.body.rateSource).toBe('RATE_AGREEMENT');
      expect(res.body.rateAgreementId).toBeTruthy();
    });

    it('sets rateSource=MANUAL_OVERRIDE and still retains rateAgreementId when the matched rate is overridden', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'rate-override');
      await adminAgent
        .post(`${API}/customers/${customerId}/rate-agreements`)
        .send({
          originCity: 'Dallas',
          originState: 'TX',
          destinationCity: 'Chicago',
          destinationState: 'IL',
          equipmentType: 'DRY_VAN',
          rate: '2450.00',
          rateType: 'FLAT',
          effectiveDate: '2020-01-01',
        })
        .expect(201);

      const res = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '2999.00' })
        .expect(201);
      expect(res.body.rateSource).toBe('MANUAL_OVERRIDE');
      expect(res.body.rateAgreementId).toBeTruthy();
    });

    it('uses rateSource=MANUAL with no rateAgreementId when no lane matches', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'rate-none');
      const res = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '500.00' })
        .expect(201);
      expect(res.body.rateSource).toBe('MANUAL');
      expect(res.body.rateAgreementId).toBeNull();
    });
  });

  describe('Quote mark-lost — Workflow 4 §4.6', () => {
    it('marks an OPEN Quote Lost with a reason', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'lost-happy');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);

      const res = await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/mark-lost`)
        .send({ reason: 'Customer chose a competitor' })
        .expect(200);
      expect(res.body.status).toBe('LOST');
    });

    it('rejects marking Lost with an empty reason', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'lost-empty-reason');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);

      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/mark-lost`)
        .send({ reason: '' })
        .expect(400);
    });

    it('a Lost Quote is permanently terminal — cannot be re-marked Lost or converted', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'lost-terminal');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/mark-lost`)
        .send({ reason: 'first reason' })
        .expect(200);

      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/mark-lost`)
        .send({ reason: 'second reason' })
        .expect(409);
      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00' })
        .expect(409);
    });
  });

  describe('Quote to Load conversion — Workflow 4 §4.7', () => {
    it('converts an OPEN Quote to a BOOKED Load, sets Quote to WON with resultingLoadId, Load carries quoteId/bookingSource=QUOTE', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'convert-happy');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '2450.00' })
        .expect(201);

      const loadRes = await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '2450.00' })
        .expect(200);
      expect(loadRes.body.status).toBe('BOOKED');
      expect(loadRes.body.bookingSource).toBe('QUOTE');
      expect(loadRes.body.quoteId).toBe(quoteRes.body.id);
      expect(loadRes.body.loadNumber).toMatch(/^LOAD-\d{6}$/);

      const quoteAfter = await adminAgent.get(`${API}/quotes/${quoteRes.body.id}`).expect(200);
      expect(quoteAfter.body.status).toBe('WON');
      expect(quoteAfter.body.resultingLoadId).toBe(loadRes.body.id);
      expect(Number(quoteAfter.body.customerRate)).toBe(2450);
    });

    it("records a rate change only when the confirmed rate differs, and never alters the Quote's own rate", async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'convert-rate-changed');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '2450.00' })
        .expect(201);

      const loadRes = await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '2600.00' })
        .expect(200);
      expect(Number(loadRes.body.customerRate)).toBe(2600);

      const quoteAfter = await adminAgent.get(`${API}/quotes/${quoteRes.body.id}`).expect(200);
      expect(Number(quoteAfter.body.customerRate)).toBe(2450);
    });

    it('blocks conversion when the Customer never became Active (still Prospect)', async () => {
      const customerId = await createCustomer(adminAgent, 'PROSPECT', 'convert-prospect');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);

      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00' })
        .expect(422);
    });

    it('blocks conversion when the Customer became Blocked after Quote creation', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'convert-blocked-later');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      await adminAgent
        .post(`${API}/customers/${customerId}/status`)
        .send({ status: 'BLOCKED' })
        .expect(200);

      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00' })
        .expect(422);
    });

    it('requires an explicit override to convert when the Customer became Inactive after Quote creation', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'convert-inactive');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      await adminAgent
        .post(`${API}/customers/${customerId}/status`)
        .send({ status: 'INACTIVE' })
        .expect(200);

      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00' })
        .expect(422);
      await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00', confirmInactiveCustomerOverride: true })
        .expect(200);
    });
  });

  describe('Direct-to-Booked creation — Workflow 4 §4.8', () => {
    it('creates a Load at BOOKED with bookingSource=DIRECT, quoteId=NULL for an Active customer', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'direct-happy');
      const res = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
        .expect(201);
      expect(res.body.status).toBe('BOOKED');
      expect(res.body.bookingSource).toBe('DIRECT');
      expect(res.body.quoteId).toBeNull();
      expect(res.body.loadNumber).toMatch(/^LOAD-\d{6}$/);
    });

    it('blocks direct booking for a Prospect customer', async () => {
      const customerId = await createCustomer(adminAgent, 'PROSPECT', 'direct-prospect');
      await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(422);
    });

    it('blocks direct booking entirely for a Blocked customer, even with the override flag set', async () => {
      const customerId = await createCustomer(adminAgent, 'BLOCKED', 'direct-blocked');
      await adminAgent
        .post(`${API}/loads`)
        .send({
          customerId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
          confirmInactiveCustomerOverride: true,
        })
        .expect(422);
    });

    it('requires an explicit override for an Inactive customer, and succeeds once given', async () => {
      const customerId = await createCustomer(adminAgent, 'INACTIVE', 'direct-inactive');
      await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(422);
      await adminAgent
        .post(`${API}/loads`)
        .send({
          customerId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
          confirmInactiveCustomerOverride: true,
        })
        .expect(201);
    });

    it('accepts optional reference numbers at booking', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'direct-refs');
      const res = await adminAgent
        .post(`${API}/loads`)
        .send({
          customerId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
          customerPoNumber: 'PO-1',
          bolNumber: 'BOL-1',
          pickupNumber: 'PU-1',
          customerReferenceNumber: 'REF-1',
        })
        .expect(201);
      expect(res.body.customerPoNumber).toBe('PO-1');
    });

    it('rejects a Load with no pickup or no delivery stop', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'direct-bad-stops');
      await adminAgent
        .post(`${API}/loads`)
        .send({
          customerId,
          stops: [LOAD_STOPS[0]],
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(422);
    });
  });

  describe('GET /loads — Frontend Phase 3 gap-fix (Dispatch Board Table View)', () => {
    it("includes each Load's stops, and filters by customerId and equipmentType", async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'list-gapfix');
      const created = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'REEFER', customerRate: '900.00' })
        .expect(201);

      const res = await adminAgent.get(`${API}/loads`).query({ customerId }).expect(200);
      const found = res.body.find((l: { id: string }) => l.id === created.body.id);
      expect(found).toBeDefined();
      expect(found.stops).toHaveLength(2);
      expect(found.stops[0]).toMatchObject({ city: 'Dallas', stopType: 'PICKUP' });

      const filtered = await adminAgent
        .get(`${API}/loads`)
        .query({ customerId, equipmentType: 'DRY_VAN' })
        .expect(200);
      expect(filtered.body.find((l: { id: string }) => l.id === created.body.id)).toBeUndefined();
    });
  });

  describe('Load & Quote numbering — Workflow 4 §4.9', () => {
    it('assigns independent, sequential numbers — a Quote never consumes a Load number', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'numbering');

      const quote1 = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      const quote2 = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      expect(quote1.body.quoteNumber).not.toBe(quote2.body.quoteNumber);

      const load1 = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      const load1Suffix = parseInt(load1.body.loadNumber.split('-')[1], 10);

      const load2 = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      const load2Suffix = parseInt(load2.body.loadNumber.split('-')[1], 10);

      // Sequential, undisturbed by the two Quote creations in between.
      expect(load2Suffix).toBe(load1Suffix + 1);
    });
  });

  describe('Reference numbers — Workflow 4 §4.10', () => {
    it('adds/updates reference numbers via PATCH at any time after booking — never required to reach BOOKED', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'refnum-patch');
      const loadRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      expect(loadRes.body.customerPoNumber).toBeNull();

      const patchRes = await adminAgent
        .patch(`${API}/loads/${loadRes.body.id}`)
        .send({ customerPoNumber: 'PO-999' })
        .expect(200);
      expect(patchRes.body.customerPoNumber).toBe('PO-999');
    });
  });

  describe('Edit Stops — PATCH /loads/:id/stops (atomic bulk stop-details correction)', () => {
    function editItem(overrides: Record<string, unknown> = {}) {
      return {
        sequence: 1,
        stopType: 'PICKUP',
        companyName: 'ABC Manufacturing',
        addressLine1: '123 Main St',
        city: 'Philadelphia',
        state: 'PA',
        zip: '19101',
        ...overrides,
      };
    }

    it('updates every submitted stop in one call and persists all fields', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'edit-stops-happy');
      const loadRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
        .expect(201);
      const loadId = loadRes.body.id;

      const patchRes = await adminAgent
        .patch(`${API}/loads/${loadId}/stops`)
        .send({
          stops: [
            editItem({ sequence: 1, companyName: 'ABC Manufacturing', city: 'Philadelphia' }),
            editItem({
              sequence: 2,
              stopType: 'DELIVERY',
              companyName: 'DEF Distribution',
              addressLine1: '456 Industrial Ave',
              city: 'Lodi',
              state: 'NJ',
              zip: '07644',
            }),
          ],
        })
        .expect(200);
      expect(patchRes.body.stops.map((s: { companyName: string }) => s.companyName).sort()).toEqual(
        ['ABC Manufacturing', 'DEF Distribution'].sort(),
      );

      const getRes = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const stopsByCompany = getRes.body.stops
        .sort((a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence)
        .map((s: { companyName: string; city: string }) => ({
          companyName: s.companyName,
          city: s.city,
        }));
      expect(stopsByCompany).toEqual([
        { companyName: 'ABC Manufacturing', city: 'Philadelphia' },
        { companyName: 'DEF Distribution', city: 'Lodi' },
      ]);
      // The Load Customer itself is untouched by a Stop company-name edit.
      expect(getRes.body.customerId).toBe(customerId);
    });

    it('rolls back the entire batch when one stop in a multi-stop update fails — no partial write', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'edit-stops-rollback');
      const loadRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
        .expect(201);
      const loadId = loadRes.body.id;
      const originalCompanyName = loadRes.body.stops.find(
        (s: { sequence: number }) => s.sequence === 1,
      ).companyName;

      await adminAgent
        .patch(`${API}/loads/${loadId}/stops`)
        .send({
          stops: [
            editItem({ sequence: 1, companyName: 'Should Never Persist' }),
            // sequence 99 does not exist on this Load — the whole
            // transaction must roll back, including stop 1's update
            // above, which is processed first in the same request.
            editItem({ sequence: 99, companyName: 'Also Should Never Persist' }),
          ],
        })
        .expect(404);

      const getRes = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const stop1 = getRes.body.stops.find((s: { sequence: number }) => s.sequence === 1);
      expect(stop1.companyName).toBe(originalCompanyName);
    });

    it('requires createQuoteOrLoad — Accounting cannot edit stops', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'edit-stops-perm');
      const loadRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
        .expect(201);

      await accountingAgent
        .patch(`${API}/loads/${loadRes.body.id}/stops`)
        .send({ stops: [editItem()] })
        .expect(403);
    });

    it('rejects a stop update missing a required field (Company Name)', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'edit-stops-validation');
      const loadRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
        .expect(201);

      await adminAgent
        .patch(`${API}/loads/${loadRes.body.id}/stops`)
        .send({ stops: [editItem({ companyName: '' })] })
        .expect(400);
    });

    it("never allows one organization's Load to have its stops edited via another organization's session", async () => {
      const orgA = await setUpOrganization('edit-stops-cross-a');
      const orgB = await setUpOrganization('edit-stops-cross-b');
      const customerAId = await createCustomer(orgA.adminAgent, 'ACTIVE', 'edit-stops-cross-cust');
      const loadARes = await orgA.adminAgent
        .post(`${API}/loads`)
        .send({
          customerId: customerAId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(201);

      await orgB.adminAgent
        .patch(`${API}/loads/${loadARes.body.id}/stops`)
        .send({ stops: [editItem()] })
        .expect(404);

      // Org A's stop is provably untouched by Org B's rejected attempt.
      const getRes = await orgA.adminAgent.get(`${API}/loads/${loadARes.body.id}`).expect(200);
      const stop1 = getRes.body.stops.find((s: { sequence: number }) => s.sequence === 1);
      expect(stop1.companyName).toBe('Test Co');
    });
  });

  describe('Dispatcher handoff boundary — Workflow 4 §4.11', () => {
    it('leaves assignedDispatcherId NULL on a newly Booked Load, regardless of path', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'dispatcher-boundary');

      const directRes = await adminAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      expect(directRes.body.assignedDispatcherId).toBeNull();

      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      const convertedRes = await adminAgent
        .post(`${API}/quotes/${quoteRes.body.id}/convert`)
        .send({ confirmedCustomerRate: '100.00' })
        .expect(200);
      expect(convertedRes.body.assignedDispatcherId).toBeNull();
    });
  });

  describe('Permissions — TECHNICAL_ARCHITECTURE.md §7', () => {
    it('Accounting cannot create a Quote or a direct-booking Load', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'perm-accounting');
      await accountingAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(403);
      await accountingAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(403);
    });

    it('Sales/Booking can create a Quote and a direct-booking Load', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'perm-sales');
      await salesAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      await salesAgent
        .post(`${API}/loads`)
        .send({ customerId, stops: LOAD_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
    });

    it('Dispatcher sees no $ fields on a Quote they did not create', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'perm-dispatcher-view');
      const quoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);

      const viewRes = await dispatcherAgent.get(`${API}/quotes/${quoteRes.body.id}`).expect(200);
      expect(viewRes.body.customerRate).toBeNull();
      expect(viewRes.body.rateSource).toBeNull();
    });

    it("Sales/Booking sees $ fields only on their own Quote, never on someone else's", async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'perm-sales-own');
      const ownQuoteRes = await salesAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);
      const othersQuoteRes = await adminAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '200.00' })
        .expect(201);

      const ownView = await salesAgent.get(`${API}/quotes/${ownQuoteRes.body.id}`).expect(200);
      expect(ownView.body.customerRate).not.toBeNull();

      const othersView = await salesAgent
        .get(`${API}/quotes/${othersQuoteRes.body.id}`)
        .expect(200);
      expect(othersView.body.customerRate).toBeNull();
    });

    it('Admin sees $ fields on every Quote regardless of ownership', async () => {
      const customerId = await createCustomer(adminAgent, 'ACTIVE', 'perm-admin-view');
      const quoteRes = await salesAgent
        .post(`${API}/quotes`)
        .send({ customerId, stops: QUOTE_STOPS, equipmentType: 'DRY_VAN', customerRate: '100.00' })
        .expect(201);

      const view = await adminAgent.get(`${API}/quotes/${quoteRes.body.id}`).expect(200);
      expect(view.body.customerRate).not.toBeNull();
    });
  });

  describe('Cross-tenant isolation for Phase 3 tables', () => {
    it("one organization's Quotes/Loads are never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const customerAId = await createCustomer(orgA.adminAgent, 'ACTIVE', 'cross-a-cust');
      const quoteARes = await orgA.adminAgent
        .post(`${API}/quotes`)
        .send({
          customerId: customerAId,
          stops: QUOTE_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(201);
      const loadARes = await orgA.adminAgent
        .post(`${API}/loads`)
        .send({
          customerId: customerAId,
          stops: LOAD_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(201);

      // --- Application-layer proof ------------------------------------
      await orgB.adminAgent.get(`${API}/quotes/${quoteARes.body.id}`).expect(404);
      await orgB.adminAgent.get(`${API}/loads/${loadARes.body.id}`).expect(404);

      const orgBQuoteList = await orgB.adminAgent.get(`${API}/quotes`).expect(200);
      expect(orgBQuoteList.body.map((q: { id: string }) => q.id)).not.toContain(quoteARes.body.id);

      // --- Database-layer (RLS) proof -----------------------------------
      // Bypass the service layer's own WHERE-clause scoping entirely and
      // issue a raw query for Org A's row while the Postgres session is
      // scoped to Org B. FORCE ROW LEVEL SECURITY must reject this even
      // though the query explicitly asks for Org A's id.
      const rowsVisibleFromWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM quote WHERE organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromWrongTenant).toHaveLength(0);

      const rowsVisibleFromOwnTenant = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM load WHERE organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromOwnTenant.length).toBeGreaterThan(0);

      // Fail-closed proof: with no tenant context set at all.
      const rowsVisibleWithNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM load WHERE organization_id = ${orgA.organizationId}::uuid`;
      expect(rowsVisibleWithNoContext).toHaveLength(0);
      // Two full setUpOrganization() calls (4 real agent logins each, with
      // real bcrypt hashing) comfortably exceed Jest's 5000ms default test
      // timeout under --runInBand's single-process sequential load —
      // explicit override, not a hidden failure.
    }, 20000);
  });
});
