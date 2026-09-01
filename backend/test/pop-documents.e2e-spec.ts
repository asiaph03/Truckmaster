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

const SINGLE_PICKUP_STOPS = [
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

/** Interleaved multi-pickup + multi-delivery load — proves stopType-only, position-independent behavior. */
const MIXED_INTERLEAVED_STOPS = [
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
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
  },
  {
    sequence: 3,
    stopType: 'PICKUP',
    companyName: 'Test Co',
    addressLine1: '3 Dock Rd',
    city: 'St. Louis',
    state: 'MO',
    zip: '63101',
  },
  {
    sequence: 4,
    stopType: 'DELIVERY',
    companyName: 'Test Co',
    addressLine1: '4 Dock Rd',
    city: 'Chicago',
    state: 'IL',
    zip: '60601',
  },
  {
    sequence: 5,
    stopType: 'PICKUP',
    companyName: 'Test Co',
    addressLine1: '5 Dock Rd',
    city: 'Memphis',
    state: 'TN',
    zip: '38101',
  },
];

/**
 * Proof of Pickup (POP) — the symmetric pickup-side counterpart of POD
 * (Workflow 7 §7.1). POP is document-tracking only: no `Load.popStatus`,
 * no milestone derivation, no invoicing/closing gate — this suite proves
 * only that the upload/versioning/permission machinery (shared with POD
 * via `DocumentService.initiateUpload`) correctly enforces PICKUP-only for
 * POP, mirrors `pod-documents.e2e-spec.ts`'s own DELIVERY-only proof, and
 * that mixed/interleaved stops each get the correct document type
 * regardless of position. Requires the same setup as every other e2e spec:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed   (system document types, including POP)
 *   npm run test:e2e
 */
describe('Proof of Pickup (POP) Upload', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'pop-documents-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let salesAgent: SuperAgentTest;
  let dispatcherAgent: SuperAgentTest;
  let accountingAgent: SuperAgentTest;
  let orgId: string;

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
        name: 'POP Documents Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    const org = await setUpOrganization('main');
    orgId = org.organizationId;
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

    const adminEmail = `admin-${seed}@pop-documents-test.test`;
    const salesEmail = `sales-${seed}@pop-documents-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@pop-documents-test.test`;
    const accountingEmail = `accounting-${seed}@pop-documents-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `POP Documents Test Org ${seed}`,
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

    return {
      organizationId: newOrgId,
      adminAgent: adminAgentLocal,
      salesAgent: salesAgentLocal,
      dispatcherAgent: dispatcherAgentLocal,
      accountingAgent: accountingAgentLocal,
    };
  }

  async function createActiveCustomer(agent: SuperAgentTest, seed: string): Promise<string> {
    const res = await agent
      .post(`${API}/customers`)
      .send({
        legalName: `POP Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@pop-documents-customer.test`,
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

  async function createBookedLoad(seed: string, stops = SINGLE_PICKUP_STOPS): Promise<string> {
    const customerId = await createActiveCustomer(adminAgent, seed);
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId, stops, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
      .expect(201);
    return res.body.id;
  }

  async function uploadPop(
    agent: SuperAgentTest,
    loadId: string,
    sequence: number,
    fileName: string,
    existingDocumentFamilyId?: string,
  ): Promise<{ documentId: string; documentFamilyId: string }> {
    const initiateRes = await agent
      .post(`${API}/loads/${loadId}/stops/${sequence}/pop-documents`)
      .send({
        fileName,
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
        ...(existingDocumentFamilyId ? { existingDocumentFamilyId } : {}),
      })
      .expect(201);
    const documentId: string = initiateRes.body.document.id;
    const documentFamilyId: string = initiateRes.body.document.documentFamilyId;

    await fetch(initiateRes.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 fake pop content'),
    });

    await agent.post(`${API}/documents/${documentId}/confirm`).expect(200);
    return { documentId, documentFamilyId };
  }

  describe('POP Upload — pickup Stop only, symmetric to POD', () => {
    it('succeeds against a pickup Stop', async () => {
      const loadId = await createBookedLoad('single-pickup');
      const { documentId } = await uploadPop(adminAgent, loadId, 1, 'pop.pdf');
      expect(documentId).toBeDefined();

      const load = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const pickupStopId: string = load.body.stops.find(
        (s: { sequence: number }) => s.sequence === 1,
      ).id;
      const docs = await adminAgent
        .get(`${API}/documents`)
        .query({ entityType: 'STOP', entityId: pickupStopId })
        .expect(200);
      expect(docs.body.some((d: { id: string }) => d.id === documentId)).toBe(true);
    });

    it('rejects a POP upload against a non-pickup (DELIVERY) stop', async () => {
      const loadId = await createBookedLoad('delivery-rejected');

      await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pop-documents`)
        .send({ fileName: 'pop.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
    });

    it('confirms the existing POD route still rejects PICKUP and still succeeds against DELIVERY (unchanged behavior)', async () => {
      const loadId = await createBookedLoad('pod-still-works');

      await adminAgent
        .post(`${API}/loads/${loadId}/stops/1/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);

      await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
    });
  });

  describe('Mixed/interleaved pickups and deliveries — strictly stopType-driven', () => {
    it('every pickup stop independently accepts its own POP, every delivery stop independently accepts its own POD, regardless of order', async () => {
      const loadId = await createBookedLoad('mixed-interleaved', MIXED_INTERLEAVED_STOPS);

      // Sequences 1, 3, 5 are PICKUP — each gets its own POP.
      const pop1 = await uploadPop(adminAgent, loadId, 1, 'pop-1.pdf');
      const pop3 = await uploadPop(adminAgent, loadId, 3, 'pop-3.pdf');
      const pop5 = await uploadPop(adminAgent, loadId, 5, 'pop-5.pdf');
      expect(new Set([pop1.documentId, pop3.documentId, pop5.documentId]).size).toBe(3);

      // Sequences 2, 4 are DELIVERY — each independently accepts its own POD.
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod-2.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/4/pod-documents`)
        .send({ fileName: 'pod-4.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);

      // Cross-type rejection still holds for every stop, not just the first of its kind.
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/1/pod-documents`)
        .send({ fileName: 'wrong.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/3/pod-documents`)
        .send({ fileName: 'wrong.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/5/pod-documents`)
        .send({ fileName: 'wrong.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pop-documents`)
        .send({ fileName: 'wrong.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
      await adminAgent
        .post(`${API}/loads/${loadId}/stops/4/pop-documents`)
        .send({ fileName: 'wrong.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
    });
  });

  describe('Replacement POPs', () => {
    it('a replacement upload creates a new version and retains the prior one', async () => {
      const loadId = await createBookedLoad('replacement');

      const { documentId: firstDocId, documentFamilyId } = await uploadPop(
        adminAgent,
        loadId,
        1,
        'pop-v1.pdf',
      );

      const { documentId: secondDocId } = await uploadPop(
        adminAgent,
        loadId,
        1,
        'pop-v2.pdf',
        documentFamilyId,
      );

      const priorVersion = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: firstDocId } }),
      );
      const currentVersion = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: secondDocId } }),
      );
      expect(priorVersion?.isCurrentVersion).toBe(false);
      expect(currentVersion?.isCurrentVersion).toBe(true);
      expect(currentVersion?.versionNumber).toBe(2);
      expect(currentVersion?.documentFamilyId).toBe(documentFamilyId);
    });
  });

  describe('Unrecognized document type against a Stop', () => {
    it('a non-POD/POP document type (e.g. BOL) cannot be uploaded against a Stop via the generic endpoint', async () => {
      const loadId = await createBookedLoad('unknown-code-rejected');
      const load = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      const pickupStopId: string = load.body.stops.find(
        (s: { sequence: number }) => s.sequence === 1,
      ).id;

      const docTypes = await adminAgent
        .get(`${API}/document-types`)
        .query({ category: 'LOAD' })
        .expect(200);
      const bolType = docTypes.body.find((t: { code: string }) => t.code === 'BOL');
      expect(bolType).toBeDefined();

      await adminAgent
        .post(`${API}/documents`)
        .send({
          entityType: 'STOP',
          entityId: pickupStopId,
          documentTypeId: bolType.id,
          fileName: 'bol.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 1024,
        })
        .expect(422);
    });
  });

  describe('Permissions — same STOP-entity role set as POD', () => {
    it('Admin, Dispatcher, and Accounting can all upload a POP', async () => {
      const loadId = await createBookedLoad('perm-allowed');

      for (const agent of [adminAgent, dispatcherAgent, accountingAgent]) {
        await agent
          .post(`${API}/loads/${loadId}/stops/1/pop-documents`)
          .send({ fileName: 'pop.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
          .expect(201);
      }
    });

    it('Sales/Booking is blocked from uploading a POP', async () => {
      const loadId = await createBookedLoad('perm-sales-blocked');

      await salesAgent
        .post(`${API}/loads/${loadId}/stops/1/pop-documents`)
        .send({ fileName: 'pop.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(403);
    });
  });
});
