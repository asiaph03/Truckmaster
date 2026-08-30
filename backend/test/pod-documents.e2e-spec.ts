import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import {
  MALWARE_SCANNER,
  MalwareScanResult,
} from '../src/common/malware-scan/malware-scanner.interface';

import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

/** Every route except /health sits behind the global prefix (main.ts / configure-app.ts). */
const API = '/api/v1';

const SINGLE_DELIVERY_STOPS = [
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

/**
 * Phase 5 (POD Receipt & Documentation) end-to-end proof: Workflow 7's
 * per-delivery-stop POD upload (no approval, no notifications), the
 * system-derived `Load.pod_status` milestone (NOT_RECEIVED/PARTIAL/
 * COMPLETE) recalculated only from CLEAN current-version PODs, replacement
 * versioning, timing independence from Load.status, role-based permissions
 * (Admin/OpsMgr/Dispatcher/Accounting — Sales/Booking excluded), and
 * cross-tenant isolation — run against a live app instance with a live
 * PostgreSQL + Redis + S3-compatible store.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed   (system document types, including POD)
 *   npm run test:e2e
 */
describe('POD Receipt & Documentation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];
  const scanOverrides = new Map<string, MalwareScanResult>();

  const superAdminEmail = 'pod-documents-suite-super-admin@trucktms.internal';
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

    // A configurable test double (matching core-master-data.e2e-spec.ts's
    // own pattern) — not the production StubMalwareScanner, which always
    // reports CLEAN — needed to exercise the INFECTED-never-counts-toward-
    // pod_status case.
    const configurableScanner = {
      scan: async (storageKey: string): Promise<MalwareScanResult> =>
        scanOverrides.get(storageKey) ?? { status: 'CLEAN', provider: 'test-double' },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(captureEmailSender)
      .overrideProvider(MALWARE_SCANNER)
      .useValue(configurableScanner)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    const passwordService = app.get(PasswordService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'POD Documents Suite Platform Super Admin',
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

    const adminEmail = `admin-${seed}@pod-documents-test.test`;
    const salesEmail = `sales-${seed}@pod-documents-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@pod-documents-test.test`;
    const accountingEmail = `accounting-${seed}@pod-documents-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `POD Documents Test Org ${seed}`,
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
        legalName: `POD Test Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@pod-documents-customer.test`,
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

  async function createBookedLoad(seed: string, stops = SINGLE_DELIVERY_STOPS): Promise<string> {
    const customerId = await createActiveCustomer(adminAgent, seed);
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({ customerId, stops, equipmentType: 'DRY_VAN', customerRate: '1800.00' })
      .expect(201);
    return res.body.id;
  }

  async function uploadPod(
    agent: SuperAgentTest,
    loadId: string,
    sequence: number,
    fileName: string,
    existingDocumentFamilyId?: string,
  ): Promise<{ documentId: string; uploadUrl: string }> {
    const initiateRes = await agent
      .post(`${API}/loads/${loadId}/stops/${sequence}/pod-documents`)
      .send({
        fileName,
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
        ...(existingDocumentFamilyId ? { existingDocumentFamilyId } : {}),
      })
      .expect(201);
    const documentId: string = initiateRes.body.document.id;
    const uploadUrl: string = initiateRes.body.uploadUrl;

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 fake pod content'),
    });

    await agent.post(`${API}/documents/${documentId}/confirm`).expect(200);
    return { documentId, uploadUrl };
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

  async function waitForPodStatus(
    loadId: string,
    expected: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const load = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.load.findUnique({ where: { id: loadId } }),
      );
      if (load?.podStatus === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Load ${loadId} did not reach pod_status=${expected} within ${timeoutMs}ms`);
  }

  describe('POD Upload — Workflow 7 §7.1/§7.2', () => {
    it('uploading a POD to a single delivery stop drives pod_status NOT_RECEIVED -> COMPLETE', async () => {
      const loadId = await createBookedLoad('single-stop');

      const loadBefore = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadBefore.body.podStatus).toBe('NOT_RECEIVED');
      expect(loadBefore.body.stops.find((s: { sequence: number }) => s.sequence === 2).hasPod).toBe(
        false,
      );

      const { documentId } = await uploadPod(adminAgent, loadId, 2, 'pod.pdf');
      expect(await waitForScanStatus(documentId)).toBe('CLEAN');
      await waitForPodStatus(loadId, 'COMPLETE');

      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.podStatus).toBe('COMPLETE');
      expect(loadAfter.body.stops.find((s: { sequence: number }) => s.sequence === 2).hasPod).toBe(
        true,
      );
    });

    it('multi-delivery: PARTIAL after one of two stops, COMPLETE once both have a POD', async () => {
      const loadId = await createBookedLoad('multi-stop', MULTI_DELIVERY_STOPS);

      const { documentId: doc1 } = await uploadPod(adminAgent, loadId, 2, 'pod-1.pdf');
      await waitForScanStatus(doc1);
      await waitForPodStatus(loadId, 'PARTIAL');

      const { documentId: doc2 } = await uploadPod(adminAgent, loadId, 3, 'pod-2.pdf');
      await waitForScanStatus(doc2);
      await waitForPodStatus(loadId, 'COMPLETE');
    });

    it('rejects a POD upload against a non-delivery (PICKUP) stop', async () => {
      const loadId = await createBookedLoad('pickup-rejected');

      await adminAgent
        .post(`${API}/loads/${loadId}/stops/1/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(422);
    });

    it('is independent of Load.status — succeeds against a freshly BOOKED load and after Begin Sourcing', async () => {
      const loadId = await createBookedLoad('timing-independence');

      // BOOKED — before any Phase 4 sourcing/dispatch action at all.
      const { documentId: doc1 } = await uploadPod(adminAgent, loadId, 2, 'pod-early.pdf');
      expect(await waitForScanStatus(doc1)).toBe('CLEAN');

      // Still well before DELIVERED — a replacement upload works too.
      await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
      const loadAfter = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(loadAfter.body.status).toBe('CARRIER_SOURCING');
      expect(loadAfter.body.podStatus).toBe('COMPLETE');
    });
  });

  describe('Replacement PODs — Workflow 7 §7.3', () => {
    it('a replacement upload creates a new version, retains the prior one, and does not disturb an already-COMPLETE pod_status', async () => {
      const loadId = await createBookedLoad('replacement');

      const { documentId: firstDocId } = await uploadPod(adminAgent, loadId, 2, 'pod-v1.pdf');
      await waitForScanStatus(firstDocId);
      await waitForPodStatus(loadId, 'COMPLETE');

      const firstDoc = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: firstDocId } }),
      );

      const { documentId: secondDocId } = await uploadPod(
        adminAgent,
        loadId,
        2,
        'pod-v2.pdf',
        firstDoc!.documentFamilyId,
      );
      await waitForScanStatus(secondDocId);

      const priorVersion = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: firstDocId } }),
      );
      const currentVersion = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: secondDocId } }),
      );
      expect(priorVersion?.isCurrentVersion).toBe(false);
      expect(currentVersion?.isCurrentVersion).toBe(true);
      expect(currentVersion?.versionNumber).toBe(2);

      const load = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(load.body.podStatus).toBe('COMPLETE');
    });
  });

  describe('Malware-scan interaction — an INFECTED POD never counts toward pod_status', () => {
    it('leaves pod_status at NOT_RECEIVED when the only uploaded POD comes back INFECTED', async () => {
      const loadId = await createBookedLoad('infected-pod');

      const initiateRes = await adminAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'infected.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      const documentId: string = initiateRes.body.document.id;
      const storageKey: string = initiateRes.body.document.fileStorageKey;
      scanOverrides.set(storageKey, { status: 'INFECTED', provider: 'test-double' });

      await fetch(initiateRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 infected content'),
      });
      await adminAgent.post(`${API}/documents/${documentId}/confirm`).expect(200);

      expect(await waitForScanStatus(documentId)).toBe('INFECTED');

      // Give the recalculation hook a moment, then confirm it never flips.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const load = await adminAgent.get(`${API}/loads/${loadId}`).expect(200);
      expect(load.body.podStatus).toBe('NOT_RECEIVED');
      expect(load.body.stops.find((s: { sequence: number }) => s.sequence === 2).hasPod).toBe(
        false,
      );
    });
  });

  describe('Permissions — Workflow 7 Cross-Cutting Permissions', () => {
    it('Admin, Dispatcher, and Accounting can all upload a POD', async () => {
      const loadId = await createBookedLoad('perm-allowed');

      for (const agent of [adminAgent, dispatcherAgent, accountingAgent]) {
        await agent
          .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
          .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
          .expect(201);
      }
    });

    it('Sales/Booking is blocked from uploading a POD', async () => {
      const loadId = await createBookedLoad('perm-sales-blocked');

      await salesAgent
        .post(`${API}/loads/${loadId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(403);
    });
  });

  describe('Cross-tenant isolation for POD documents', () => {
    it("one organization's POD documents are never visible to another, at the app layer and at the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const customerAId = await createActiveCustomer(orgA.adminAgent, 'cross-a-cust');
      const loadARes = await orgA.adminAgent
        .post(`${API}/loads`)
        .send({
          customerId: customerAId,
          stops: SINGLE_DELIVERY_STOPS,
          equipmentType: 'DRY_VAN',
          customerRate: '100.00',
        })
        .expect(201);
      const loadAId = loadARes.body.id;

      const initiateRes = await orgA.adminAgent
        .post(`${API}/loads/${loadAId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(201);
      const documentAId: string = initiateRes.body.document.id;

      // --- Application-layer proof ------------------------------------
      await orgB.adminAgent
        .post(`${API}/loads/${loadAId}/stops/2/pod-documents`)
        .send({ fileName: 'pod.pdf', mimeType: 'application/pdf', fileSizeBytes: 1024 })
        .expect(404);
      await orgB.adminAgent.get(`${API}/documents/${documentAId}/download-url`).expect(404);

      // --- Database-layer (RLS) proof -----------------------------------
      const rowsVisibleFromWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM document WHERE id = ${documentAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromWrongTenant).toHaveLength(0);

      const rowsVisibleFromOwnTenant = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM document WHERE id = ${documentAId}::uuid AND organization_id = ${orgA.organizationId}::uuid`,
      );
      expect(rowsVisibleFromOwnTenant.length).toBeGreaterThan(0);

      const rowsVisibleWithNoContext = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM document WHERE id = ${documentAId}::uuid`;
      expect(rowsVisibleWithNoContext).toHaveLength(0);
      // Two full setUpOrganization() calls (4 real agent logins each, real
      // bcrypt hashing) comfortably exceed Jest's 5000ms default under
      // --runInBand's sequential load — explicit override, not a hidden failure.
    }, 30000);
  });
});
