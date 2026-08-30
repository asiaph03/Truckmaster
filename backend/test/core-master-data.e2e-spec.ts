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

/**
 * Phase 2 (Core Master Data) end-to-end proof: Customer creation +
 * duplicate detection, full Carrier onboarding through Activation
 * (compliance docs, insurance, FMCSA, self-review prevention,
 * eligibility), document malware-scan quarantine, and cross-tenant RLS
 * isolation for the new tables — run against a live app instance with a
 * live PostgreSQL + Redis + S3-compatible (MinIO) store.
 *
 * Requires the same setup as test/identity.e2e-spec.ts, PLUS the Phase 2
 * migration/RLS and a reachable S3-compatible store on `S3_ENDPOINT` (for
 * the real presigned-URL PUT this file performs against a running
 * document upload) — natively (README.md "Local Development": native
 * `minio.exe`, `tms-documents` bucket created once) or via
 * `docker compose up -d` (its `minio-init` service creates the bucket
 * automatically). See the Phase 2 verification report for current
 * pass/fail status against real infrastructure.
 *
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Core Master Data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];
  const scanOverrides = new Map<string, MalwareScanResult>();

  // Distinct from identity.e2e-spec.ts's own super-admin fixture email —
  // e2e spec files run in parallel workers against the same live shared
  // database (no per-file reset), so an identical literal here previously
  // raced identity.e2e-spec.ts's beforeAll for the same unique email.
  const superAdminEmail = 'core-master-data-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

  let orgId: string;
  let adminAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;

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

    // A configurable test double, per TECHNICAL_ARCHITECTURE.md §16's own
    // testing strategy ("Mock IMalwareScanner returning each status") —
    // not the production StubMalwareScanner, which always reports CLEAN.
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
        name: 'Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });

    // The 4 compliance-gating system-default document types (out of the
    // full 13 in prisma/seed.ts) actually exercised by this suite.
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
   * yet the instant the triggering HTTP call returns. Polls briefly,
   * mirroring the existing wait-for-async-BullMQ-side-effect pattern
   * (waitForScanStatus below).
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

  /**
   * `seed` must be unique per call within this file — reusing an email
   * across two organizations would trigger Decision 1's existing-identity
   * reuse (Phase 1) and give the second org's "admin" a multi-org session
   * that doesn't auto-select an organization, breaking every downstream
   * call's `RequestContextStore.requireOrganizationId()`. That multi-org
   * login interaction is already covered by identity.e2e-spec.ts — not
   * this file's concern.
   */
  async function setUpOrganization(seed: string) {
    const superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${seed}@phase2-test.test`;
    const reviewerEmail = `reviewer-${seed}@phase2-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Phase 2 Test Org ${seed}`,
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

    const adminToken = extractToken((await lastEmailTo(adminEmail)).body);
    await (
      await withCsrf(request.agent(app.getHttpServer()))
    )
      .post(`${API}/auth/activate`)
      .send({ token: adminToken, password: 'OrgAdminPass123' })
      .expect(200);

    const agent = await withCsrf(request.agent(app.getHttpServer()));
    await agent
      .post(`${API}/auth/login`)
      .send({ email: adminEmail, password: 'OrgAdminPass123' })
      .expect(200);

    // A second identity holding ONLY the Compliance Reviewer role, so
    // Workflow 3 §3.4's uploader != reviewer separation is a real,
    // distinct actor — not just a role check against the same user.
    const inviteRes = await agent
      .post(`${API}/memberships/invite`)
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerToken = extractToken((await lastEmailTo(reviewerEmail)).body);
    await (
      await withCsrf(request.agent(app.getHttpServer()))
    )
      .post(`${API}/auth/activate`)
      .send({ token: reviewerToken, password: 'ReviewerPass123' })
      .expect(200);

    const revAgent = await withCsrf(request.agent(app.getHttpServer()));
    await revAgent
      .post(`${API}/auth/login`)
      .send({ email: reviewerEmail, password: 'ReviewerPass123' })
      .expect(200);

    return {
      organizationId: newOrgId,
      adminAgent: agent,
      reviewerAgent: revAgent,
      reviewerMembershipId: inviteRes.body.id,
    };
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

    // Real PUT to the presigned URL, exactly as a browser client would —
    // requires MinIO actually reachable.
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

  beforeAll(async () => {
    const org = await setUpOrganization('main');
    orgId = org.organizationId;
    adminAgent = org.adminAgent;
    reviewerAgent = org.reviewerAgent;
  });

  describe('Customer — Workflow 2', () => {
    const baseDto = {
      legalName: 'Northbound Shippers Inc',
      billingAddressLine1: '10 Commerce St',
      billingCity: 'Fort Worth',
      billingState: 'TX',
      billingZip: '76102',
      primaryContactName: 'Pat Booker',
      primaryContactEmail: 'pat@northbound-shippers.test',
      primaryContactPhone: '555-0200',
    };

    it('creates a Customer at status Prospect inheriting the org default payment terms', async () => {
      const res = await adminAgent.post(`${API}/customers`).send(baseDto).expect(201);
      expect(res.body.status).toBe('PROSPECT');
      expect(res.body.paymentTerms).toBe('NET_30');
      expect(res.body.paymentTermsSource).toBe('INHERITED');
    });

    it('warns (409) on a likely duplicate, then proceeds once acknowledged', async () => {
      await adminAgent
        .post(`${API}/customers`)
        .send({ ...baseDto, primaryContactEmail: 'different@northbound-shippers.test' })
        .expect(409);

      await adminAgent
        .post(`${API}/customers`)
        .send({
          ...baseDto,
          primaryContactEmail: 'different@northbound-shippers.test',
          acknowledgeDuplicates: true,
        })
        .expect(201);
    });

    it('adds a contact, a location, and a rate agreement', async () => {
      // Same legalName/billingAddress as the two customers created above —
      // findDuplicates() matches on legalName OR billingAddress OR email
      // (customer.service.ts), so this also needs acknowledgeDuplicates
      // regardless of using a fresh email.
      const customer = await adminAgent
        .post(`${API}/customers`)
        .send({
          ...baseDto,
          primaryContactEmail: 'unique@northbound-shippers.test',
          acknowledgeDuplicates: true,
        })
        .expect(201);
      const customerId = customer.body.id;

      await adminAgent
        .post(`${API}/customers/${customerId}/contacts`)
        .send({ name: 'Ops Contact', role: 'OPERATIONS' })
        .expect(201);
      await adminAgent
        .post(`${API}/customers/${customerId}/locations`)
        .send({
          name: 'Main DC',
          addressLine1: '1 Warehouse Way',
          city: 'Plano',
          state: 'TX',
          zip: '75024',
          locationType: 'PICKUP',
        })
        .expect(201);
      await adminAgent
        .post(`${API}/customers/${customerId}/rate-agreements`)
        .send({
          originCity: 'Dallas',
          originState: 'TX',
          destinationCity: 'Atlanta',
          destinationState: 'GA',
          equipmentType: 'DRY_VAN',
          rate: '2450.00',
          rateType: 'flat',
          effectiveDate: '2026-01-01',
        })
        .expect(201);
    });
  });

  describe('Carrier — Workflow 3 full onboarding to Active', () => {
    let carrierId: string;

    it('creates a Carrier at status PENDING, ineligible by default', async () => {
      const res = await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'Reliable Freight Carriers LLC',
          mcNumber: 'MC-900001',
          dotNumber: 'DOT-900001',
          addressLine1: '5 Dock Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Carrier Dispatch',
          primaryContactPhone: '555-0300',
          primaryContactEmail: 'dispatch@reliable-freight.test',
        })
        .expect(201);

      carrierId = res.body.id;
      expect(res.body.status).toBe('PENDING');
      expect(res.body.assignmentEligible).toBe(false);
    });

    it('hard-blocks a second carrier with the same MC number (no acknowledge override exists)', async () => {
      await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'A Different Name',
          mcNumber: 'MC-900001',
          dotNumber: 'DOT-999999',
          addressLine1: '1 Other Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Someone',
          primaryContactPhone: '555-0301',
          primaryContactEmail: 'other@example.test',
        })
        .expect(409);
    });

    it('blocks activation while requirements are unmet, then activates once all 7 conditions are satisfied', async () => {
      // POST /carriers/:id/activate is @Roles('COMPLIANCE_REVIEWER') only
      // (carrier.controller.ts) — must use reviewerAgent, matching the
      // success-path call later in this same test.
      await reviewerAgent.post(`${API}/carriers/${carrierId}/activate`).expect(409);

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

      // Self-review prevention (§3.4): the reviewer cannot approve a
      // document they themselves uploaded. CARRIER_DOCUMENT_UPLOAD_ROLES
      // (document.service.ts) doesn't include COMPLIANCE_REVIEWER, so a
      // reviewer-only actor can never upload a carrier document in the
      // first place — the self-review case can only arise for someone who
      // holds an upload-permitted role AND COMPLIANCE_REVIEWER at once.
      // review()'s check is purely uploadedByUserId === actingUserId (not
      // role-based), so this exercises the identical rule the pure-role
      // reviewer scenario would have, without requiring a permission the
      // matrix doesn't grant.
      const dualRoleEmail = 'dual-role-reviewer@phase2-test.test';
      await adminAgent
        .post(`${API}/memberships/invite`)
        .send({ email: dualRoleEmail, roles: ['ADMIN', 'COMPLIANCE_REVIEWER'] })
        .expect(201);
      const dualRoleToken = extractToken((await lastEmailTo(dualRoleEmail)).body);
      await (
        await withCsrf(request.agent(app.getHttpServer()))
      )
        .post(`${API}/auth/activate`)
        .send({ token: dualRoleToken, password: 'DualRolePass123' })
        .expect(200);
      const dualRoleAgent = await withCsrf(request.agent(app.getHttpServer()));
      await dualRoleAgent
        .post(`${API}/auth/login`)
        .send({ email: dualRoleEmail, password: 'DualRolePass123' })
        .expect(200);

      const dualRoleOwnUpload = await uploadAndConfirm(
        dualRoleAgent,
        carrierId,
        mcAuthorityTypeId,
        'v2.pdf',
      );
      await waitForScanStatus(dualRoleOwnUpload);
      await dualRoleAgent
        .post(`${API}/carriers/${carrierId}/documents/${dualRoleOwnUpload}/review`)
        .send({ decision: 'APPROVED' })
        .expect(403);
      // A genuinely different reviewer CAN approve it — otherwise this
      // extra mc-authority upload (more recent than mcId, per
      // carrier-eligibility.service.ts's uploadedAt-desc pick of the
      // "current" document for a given required type) would permanently
      // block activation despite mcId already being approved below.
      await reviewerAgent
        .post(`${API}/carriers/${carrierId}/documents/${dualRoleOwnUpload}/review`)
        .send({ decision: 'APPROVED' })
        .expect(200);

      // Reviewer approves the Admin-uploaded documents (different actor
      // than the uploader — the success path).
      for (const id of [w9Id, caId, mcId]) {
        await reviewerAgent
          .post(`${API}/carriers/${carrierId}/documents/${id}/review`)
          .send({ decision: 'APPROVED' })
          .expect(200);
      }
      await reviewerAgent
        .post(`${API}/carriers/${carrierId}/documents/${coiId}/review`)
        .send({ decision: 'APPROVED' })
        .expect(200);

      const futureDate = '2030-01-01';
      await adminAgent
        .post(`${API}/carriers/${carrierId}/insurance`)
        .send({
          coverageType: 'AUTO_LIABILITY',
          coverageAmount: '1000000.00',
          insuranceCompany: 'Test Insurance Co',
          effectiveDate: '2026-01-01',
          expirationDate: futureDate,
          coiDocumentId: coiId,
        })
        .expect(201);
      await adminAgent
        .post(`${API}/carriers/${carrierId}/insurance`)
        .send({
          coverageType: 'CARGO',
          coverageAmount: '100000.00',
          insuranceCompany: 'Test Insurance Co',
          effectiveDate: '2026-01-01',
          expirationDate: futureDate,
          coiDocumentId: coiId,
        })
        .expect(201);

      await reviewerAgent
        .post(`${API}/carriers/${carrierId}/fmcsa-verification`)
        .send({ verificationDate: '2026-01-01', resultStatus: 'Authorized' })
        .expect(201);

      const activateRes = await reviewerAgent
        .post(`${API}/carriers/${carrierId}/activate`)
        .expect(200);
      expect(activateRes.body.status).toBe('ACTIVE');

      const carrierRes = await adminAgent.get(`${API}/carriers/${carrierId}`).expect(200);
      expect(carrierRes.body.assignmentEligible).toBe(true);
      expect(carrierRes.body.ineligibilityReasons).toEqual([]);
    });

    it('rejects re-activating an already-Active carrier', async () => {
      await reviewerAgent.post(`${API}/carriers/${carrierId}/activate`).expect(422);
    });
  });

  describe('Compliance Review Queue — Frontend Phase 5 gap-fix (GET /documents/pending-review)', () => {
    it('lists a pending-review Carrier document with its carrierLegalName, excludes it once reviewed, and is Compliance-Reviewer-only', async () => {
      const carrier = await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'Compliance Queue Test Carrier',
          mcNumber: 'MC-900003',
          dotNumber: 'DOT-900003',
          addressLine1: '1 Queue Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-0500',
          primaryContactEmail: 'dispatch@queue-test.test',
        })
        .expect(201);
      const queueCarrierId: string = carrier.body.id;

      // A non-reviewer role (Admin alone, no COMPLIANCE_REVIEWER) must be
      // blocked — this endpoint reuses the exact same role restriction as
      // POST /documents/:id/review, not a broader "anyone who can view a
      // Carrier" rule.
      await adminAgent.get(`${API}/documents/pending-review`).expect(403);

      const beforeUpload = await reviewerAgent.get(`${API}/documents/pending-review`).expect(200);
      expect(
        (beforeUpload.body as { id: string; entityId: string }[]).some(
          (d) => d.entityId === queueCarrierId,
        ),
      ).toBe(false);

      const w9Id = await uploadAndConfirm(adminAgent, queueCarrierId, w9TypeId, 'w9.pdf');
      await waitForScanStatus(w9Id);

      const afterUpload = await reviewerAgent.get(`${API}/documents/pending-review`).expect(200);
      const queued = (
        afterUpload.body as { id: string; entityId: string; carrierLegalName: string }[]
      ).find((d) => d.id === w9Id);
      expect(queued).toBeDefined();
      expect(queued?.entityId).toBe(queueCarrierId);
      expect(queued?.carrierLegalName).toBe('Compliance Queue Test Carrier');

      await reviewerAgent
        .post(`${API}/carriers/${queueCarrierId}/documents/${w9Id}/review`)
        .send({ decision: 'APPROVED' })
        .expect(200);

      const afterReview = await reviewerAgent.get(`${API}/documents/pending-review`).expect(200);
      expect((afterReview.body as { id: string }[]).some((d) => d.id === w9Id)).toBe(false);
    });
  });

  describe('Document malware scan — quarantine (Decision 10)', () => {
    it('quarantines an infected upload and refuses to issue a download URL for it', async () => {
      const carrier = await adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: 'Quarantine Test Carrier',
          mcNumber: 'MC-900002',
          dotNumber: 'DOT-900002',
          addressLine1: '1 Dock Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-0400',
          primaryContactEmail: 'dispatch@quarantine-test.test',
        })
        .expect(201);

      const initiateRes = await adminAgent
        .post(`${API}/carriers/${carrier.body.id}/documents`)
        .send({
          documentTypeId: w9TypeId,
          fileName: 'infected.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 10,
        })
        .expect(201);
      const documentId: string = initiateRes.body.document.id;
      const storageKey: string = initiateRes.body.document.fileStorageKey;

      scanOverrides.set(storageKey, { status: 'INFECTED', provider: 'test-double' });

      await fetch(initiateRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from('fake infected content'),
      });
      await adminAgent.post(`${API}/documents/${documentId}/confirm`).expect(200);

      expect(await waitForScanStatus(documentId)).toBe('INFECTED');
      await adminAgent.get(`${API}/documents/${documentId}/download-url`).expect(422);
    });
  });

  describe('Document Types — Frontend Phase 2 gap-fix (GET /document-types)', () => {
    it('lists the system-default document types, unfiltered', async () => {
      const res = await adminAgent.get(`${API}/document-types`).expect(200);

      const ids = res.body.map((t: { id: string }) => t.id);
      expect(ids).toEqual(
        expect.arrayContaining([w9TypeId, coiTypeId, carrierAgreementTypeId, mcAuthorityTypeId]),
      );
    });

    it('filters by category', async () => {
      const res = await adminAgent
        .get(`${API}/document-types`)
        .query({ category: 'CARRIER_COMPLIANCE' })
        .expect(200);

      expect(res.body.length).toBeGreaterThan(0);
      for (const type of res.body) {
        expect(type.category).toBe('CARRIER_COMPLIANCE');
      }
    });

    it('is readable by a Compliance Reviewer too — no @Roles() restriction, matching GET /documents', async () => {
      await reviewerAgent.get(`${API}/document-types`).expect(200);
    });
  });

  describe('Cross-tenant isolation for Phase 2 tables', () => {
    it("one organization's Customers/Carriers are never visible to another, at the app layer and at the RLS layer", async () => {
      const orgB = await setUpOrganization('rls-cross-tenant');

      await orgB.adminAgent
        .post(`${API}/customers`)
        .send({
          legalName: 'Org B Only Customer',
          billingAddressLine1: '1 B St',
          billingCity: 'Houston',
          billingState: 'TX',
          billingZip: '77002',
          primaryContactName: 'B Contact',
          primaryContactEmail: 'b@orgb-test.test',
          primaryContactPhone: '555-0500',
        })
        .expect(201);

      const orgACustomers = await adminAgent.get(`${API}/customers`).expect(200);
      const names = orgACustomers.body.map((c: { legalName: string }) => c.legalName);
      expect(names).not.toContain('Org B Only Customer');

      const rowsFromWrongTenant = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT * FROM customer WHERE organization_id = ${orgId}::uuid`,
      );
      expect(rowsFromWrongTenant).toHaveLength(0);

      const rowsFromOwnTenant = await prisma.withTenantTransaction(
        orgId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT * FROM customer WHERE organization_id = ${orgId}::uuid`,
      );
      expect(rowsFromOwnTenant.length).toBeGreaterThan(0);
    });
  });
});
