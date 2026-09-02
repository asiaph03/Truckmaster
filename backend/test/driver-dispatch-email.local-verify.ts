import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { StorageService } from '../src/common/storage/storage.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';
import { MALWARE_SCANNER } from '../src/common/malware-scan/malware-scanner.interface';

import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;
type CapturedEmail = {
  to: string;
  subject: string;
  body: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};

const API = '/api/v1';

/**
 * LOCAL DRIVER DISPATCH EMAIL VERIFICATION ONLY.
 *
 * Not part of the standard e2e suite (see setup-e2e-env.local-driver-
 * dispatch.ts's own doc comment for why) — run only via:
 *   npm run test:e2e:local-driver-dispatch
 *
 * Requires the isolated local stack already up:
 *   - PostgreSQL "tms_local_test" (migrated + RLS applied + seeded)
 *   - Redis reachable on 127.0.0.1:6379, database 1
 *   - s3rver (npm run s3:local) reachable on 127.0.0.1:9000, bucket
 *     "tms-documents"
 *
 * Verifies the full Driver Dispatch Email feature against real
 * Postgres/Redis/S3 and the real EmailSendWorker/attachment-resolution
 * pipeline — the ONLY thing intercepted is the outbound transport
 * (EMAIL_SENDER is overridden with a capturing test double, exactly the
 * established pattern in pod-documents.e2e-spec.ts /
 * sourcing-dispatch.e2e-spec.ts). No network call to Postmark ever
 * happens in this run.
 */
describe('Driver Dispatch Email — local isolated-environment verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let capturedEmails: CapturedEmail[];

  // Suffixed with a run-unique seed — this is a real, persistent local
  // Postgres database (not reset between runs), so fixed emails would
  // collide with rows left behind by a prior run of this same file.
  const runSeed = Date.now();
  const superAdminEmail = `driver-dispatch-local-verify-super-admin-${runSeed}@trucktms.internal`;
  const superAdminPassword = 'SuperAdminPass123';

  let adminAgent: SuperAgentTest;
  let reviewerAgent: SuperAgentTest;
  let orgId: string;

  let w9TypeId: string;
  let coiTypeId: string;
  let carrierAgreementTypeId: string;
  let mcAuthorityTypeId: string;
  let intakeDocTypeId: string;

  beforeAll(async () => {
    // Defense in depth — refuse to run at all against anything that
    // isn't obviously the isolated local stack, even though the setup
    // file above should already guarantee this.
    if (!process.env.DATABASE_URL?.includes('tms_local_test')) {
      throw new Error(
        `Refusing to run: DATABASE_URL does not target tms_local_test (got: ${process.env.DATABASE_URL}).`,
      );
    }
    if (!process.env.REDIS_URL?.endsWith('/1')) {
      throw new Error(
        `Refusing to run: REDIS_URL does not target database 1 (got: ${process.env.REDIS_URL}).`,
      );
    }

    capturedEmails = [];
    const captureEmailSender: IEmailSender = {
      send: async (message) => {
        capturedEmails.push(message as CapturedEmail);
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
    storage = app.get(StorageService);
    const passwordService = app.get(PasswordService);

    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: 'Driver Dispatch Local Verify Super Admin',
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

    const intakeType = await prisma.documentTypeDefinition.findFirst({
      where: { code: 'RATE_CONFIRMATION_INTAKE' },
    });
    if (!intakeType) throw new Error('RATE_CONFIRMATION_INTAKE document type is not seeded.');
    intakeDocTypeId = intakeType.id;

    const superAdminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await superAdminAgent
      .post(`${API}/auth/login`)
      .send({ email: superAdminEmail, password: superAdminPassword })
      .expect(200);

    const adminEmail = `admin-${runSeed}@driver-dispatch-local-verify.test`;
    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: 'Driver Dispatch Local Verify Org',
        addressLine1: '1 Main St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Org Admin',
        primaryContactEmail: adminEmail,
        primaryContactPhone: '555-0100',
      })
      .expect(201);
    orgId = createRes.body.organization.id;

    const token = extractToken((await lastEmailTo(adminEmail)).body);
    await (
      await withCsrf(request.agent(app.getHttpServer()))
    )
      .post(`${API}/auth/activate`)
      .send({ token, password: 'OrgAdminPass123' })
      .expect(200);
    adminAgent = await withCsrf(request.agent(app.getHttpServer()));
    await adminAgent
      .post(`${API}/auth/login`)
      .send({ email: adminEmail, password: 'OrgAdminPass123' })
      .expect(200);

    const reviewerEmail = `reviewer-${runSeed}@driver-dispatch-local-verify.test`;
    await adminAgent
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
    reviewerAgent = await withCsrf(request.agent(app.getHttpServer()));
    await reviewerAgent
      .post(`${API}/auth/login`)
      .send({ email: reviewerEmail, password: 'ReviewerPass123' })
      .expect(200);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  function extractToken(body: string): string {
    const match = body.match(/token=([a-f0-9]{64})/);
    if (!match) throw new Error(`No invitation/activation token found in email body: ${body}`);
    return match[1];
  }

  async function lastEmailTo(to: string, timeoutMs = 5000): Promise<CapturedEmail> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const email = [...capturedEmails].reverse().find((m) => m.to === to);
      if (email) return email;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No email captured for ${to}`);
  }

  async function uploadAndConfirm(
    carrierId: string,
    documentTypeId: string,
    fileName: string,
  ): Promise<string> {
    const initiateRes = await adminAgent
      .post(`${API}/carriers/${carrierId}/documents`)
      .send({ documentTypeId, fileName, mimeType: 'application/pdf', fileSizeBytes: 1024 })
      .expect(201);
    const documentId: string = initiateRes.body.document.id;
    await fetch(initiateRes.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 fake carrier compliance doc'),
    });
    await adminAgent.post(`${API}/documents/${documentId}/confirm`).expect(200);
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

  async function waitForGenerationStatus(
    documentId: string,
    expected: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const doc = await prisma.withTenantTransaction(orgId, (tx) =>
        tx.document.findUnique({ where: { id: documentId } }),
      );
      if (doc?.generationStatus === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Document ${documentId} did not reach generationStatus=${expected}`);
  }

  async function createEligibleCarrier(rawSeed: string): Promise<string> {
    const seed = `${rawSeed}-${runSeed}`;
    const res = await adminAgent
      .post(`${API}/carriers`)
      .send({
        legalName: `Local Verify Carrier ${seed}`,
        mcNumber: `MC-LV-${seed}`,
        dotNumber: `DOT-LV-${seed}`,
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

    const w9Id = await uploadAndConfirm(carrierId, w9TypeId, 'w9.pdf');
    const caId = await uploadAndConfirm(carrierId, carrierAgreementTypeId, 'agreement.pdf');
    const mcId = await uploadAndConfirm(carrierId, mcAuthorityTypeId, 'mc-authority.pdf');
    const coiId = await uploadAndConfirm(carrierId, coiTypeId, 'coi.pdf');
    for (const id of [w9Id, caId, mcId, coiId]) {
      expect(await waitForScanStatus(id)).toBe('CLEAN');
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

  async function createActiveCustomer(rawSeed: string): Promise<string> {
    const seed = `${rawSeed}-${runSeed}`;
    const res = await adminAgent
      .post(`${API}/customers`)
      .send({
        legalName: `Local Verify Customer ${seed}`,
        billingAddressLine1: '1 Commerce St',
        billingCity: 'Fort Worth',
        billingState: 'TX',
        billingZip: '76102',
        primaryContactName: 'Contact',
        primaryContactEmail: `contact-${seed}@local-verify-customer.test`,
        primaryContactPhone: '555-0200',
        acknowledgeDuplicates: true,
      })
      .expect(201);
    const customerId: string = res.body.id;
    await adminAgent
      .post(`${API}/customers/${customerId}/status`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    return customerId;
  }

  /** Pickup stop notes use the exact canonical "Label: value" per-line format the Rate Confirmation extraction feature persists. */
  const APPROVED_PICKUP_NOTES = [
    'Reefer Ref#: MR2',
    'Mileage: 112 Miles',
    'Commodity: Truckload of Produce',
    'Pickup Weight: 42,365 lbs',
    'Special Instructions: reefer pre cooled to 32 degrees',
    'Internal Order#: 56631',
    'Invoice Email: information@bascianiexpress.com',
    'Detention Policy: 2 hours free time; $50.00/hour after',
    'Driver must call 30 min out.', // unrelated dispatcher note — must NOT leak into the email
  ].join('\n');

  async function createBookedLoad(seed: string): Promise<{ loadId: string; loadNumber: string }> {
    const customerId = await createActiveCustomer(seed);
    const res = await adminAgent
      .post(`${API}/loads`)
      .send({
        customerId,
        stops: [
          {
            sequence: 1,
            stopType: 'PICKUP',
            companyName: 'I Love Produce',
            addressLine1: '15 Commerce Blvd',
            city: 'West Grove',
            state: 'PA',
            zip: '19390',
            contactName: 'Eric Frasse',
            contactPhone: '(610) 212-1201',
            notes: APPROVED_PICKUP_NOTES,
          },
          {
            sequence: 2,
            stopType: 'DELIVERY',
            companyName: 'Jetro % Americold',
            addressLine1: '501 Kentile Rd',
            city: 'South Plainfield',
            state: 'NJ',
            zip: '07080',
            contactPhone: '(908) 756-6242',
          },
        ],
        equipmentType: 'REEFER',
        customerRate: '950.00',
        customerPoNumber: '120-25370',
      })
      .expect(201);
    return { loadId: res.body.id, loadNumber: res.body.loadNumber };
  }

  /** Carries a freshly-Booked Load to RATE_CONFIRMATION with its real, fully-generated PDF. */
  async function progressToRateConfirmation(
    loadId: string,
    carrierId: string,
  ): Promise<{ documentId: string; fileStorageKey: string; fileName: string }> {
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate: '900.00' })
      .expect(200);
    await adminAgent.post(`${API}/loads/${loadId}/generate-rate-confirmation`).send({}).expect(200);

    const docs = await adminAgent
      .get(`${API}/documents`)
      .query({ entityType: 'LOAD', entityId: loadId })
      .expect(200);
    const rateConfDoc = docs.body.find((d: { fileName: string }) =>
      d.fileName.startsWith('RateConfirmation-'),
    );
    expect(rateConfDoc).toBeDefined();
    await waitForGenerationStatus(rateConfDoc.id, 'COMPLETE');
    const doc = await prisma.withTenantTransaction(orgId, (tx) =>
      tx.document.findUniqueOrThrow({ where: { id: rateConfDoc.id } }),
    );
    return { documentId: doc.id, fileStorageKey: doc.fileStorageKey, fileName: doc.fileName };
  }

  /** A decoy RATE_CONFIRMATION_INTAKE document on the same Load — proves resolution is by document TYPE, never accidentally by "any PDF on this Load". */
  async function createDecoyIntakeDocument(
    loadId: string,
    uploadedByUserId: string,
  ): Promise<void> {
    await prisma.withTenantTransaction(orgId, (tx) =>
      tx.document.create({
        data: {
          organizationId: orgId,
          entityType: 'LOAD',
          entityId: loadId,
          documentTypeId: intakeDocTypeId,
          fileStorageKey: `org_${orgId}/documents/decoy-intake.pdf`,
          fileName: 'DECOY-uploaded-intake.pdf',
          fileSizeBytes: 999,
          mimeType: 'application/pdf',
          versionNumber: 1,
          isCurrentVersion: true,
          scanStatus: 'CLEAN',
          scannedAt: new Date(),
          scanProvider: 'test-double',
          reviewStatus: 'NOT_APPLICABLE',
          uploadedByUserId,
        },
      }),
    );
  }

  it('resolves the driver email from sourceDriverId, sends via the real pipeline with the exact formatter output and the real generated Rate Confirmation PDF as an attachment (never the intake document)', async () => {
    const carrierId = await createEligibleCarrier('happy');
    const { loadId, loadNumber } = await createBookedLoad('happy');
    const rateConf = await progressToRateConfirmation(loadId, carrierId);

    // Decoy — must never be selected as the attachment.
    const meRes = await adminAgent.get(`${API}/auth/me`).expect(200);
    await createDecoyIntakeDocument(loadId, meRes.body.id);

    const driverRes = await adminAgent
      .post(`${API}/carriers/${carrierId}/drivers`)
      .send({
        firstName: 'Julia',
        lastName: 'Ramos',
        phone: '(773) 870-1332',
        email: 'julia.driver@local-verify-driver.test',
      })
      .expect(201);
    const driverId: string = driverRes.body.id;

    await adminAgent
      .post(`${API}/loads/${loadId}/dispatch`)
      .send({
        driverName: 'Julia',
        driverPhone: '(773) 870-1332',
        truckNumber: 'T-1',
        trailerNumber: 'TR-1',
        sourceDriverId: driverId,
      })
      .expect(200);

    // --- (2) action available once dispatched, (3) recipient resolved from sourceDriverId ---
    const preview = await adminAgent
      .get(`${API}/loads/${loadId}/driver-dispatch-email-preview`)
      .expect(200);
    expect(preview.body.recipientEmail).toBe('julia.driver@local-verify-driver.test');

    // --- (8) exact subject ---
    expect(preview.body.subject).toBe(`Dispatch Details — Load #${loadNumber}`);

    // --- (7) Reefer section: two distinct, verbatim lines ---
    const lines: string[] = preview.body.body.split('\n');
    expect(lines).toContain('🔑 Reefer Ref#: MR2');
    expect(lines).toContain('🔑 Special Instructions: reefer pre cooled to 32 degrees');
    expect(preview.body.body).not.toMatch(/🔑 Reefer:/);
    // Unapproved dispatcher free-text must never leak into the email.
    expect(preview.body.body).not.toContain('Driver must call 30 min out.');

    // --- (9)/(10) attachment resolves to the canonical RATE_CONFIRMATION doc, not the intake decoy ---
    expect(preview.body.attachmentAvailable).toBe(true);
    expect(preview.body.attachmentFileName).toBe(rateConf.fileName);
    expect(preview.body.attachmentFileName).not.toBe('DECOY-uploaded-intake.pdf');

    // --- send ---
    const sendRes = await adminAgent
      .post(`${API}/loads/${loadId}/send-driver-dispatch-email`)
      .send({})
      .expect(200);
    expect(sendRes.body.recipientEmail).toBe('julia.driver@local-verify-driver.test');

    const sent = await lastEmailTo('julia.driver@local-verify-driver.test');

    // --- (6) preview body === the actual sent body/subject, byte-identical ---
    expect(sent.subject).toBe(preview.body.subject);
    expect(sent.body).toBe(preview.body.body);

    // --- (11)/(12)/(13) attachment passed through the queue/worker correctly ---
    expect(sent.attachments).toHaveLength(1);
    const attachment = sent.attachments![0];
    expect(attachment.filename).toBe(rateConf.fileName);
    expect(attachment.contentType).toBe('application/pdf');

    // The worker resolved these bytes via StorageService.getObject(fileStorageKey)
    // — independently re-fetch the same key and confirm byte-for-byte equality,
    // proving the real generated PDF (not a placeholder) made it all the way
    // through Document -> S3 -> EmailSendWorker -> IEmailSender.
    const independentlyFetched = await storage.getObject(rateConf.fileStorageKey);
    expect(attachment.content.equals(independentlyFetched)).toBe(true);
    expect(attachment.content.length).toBeGreaterThan(0);
    // A real pdfkit-generated PDF starts with the standard PDF header.
    expect(attachment.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // --- carrier email never used as a fallback for THIS Load's driver dispatch email ---
    const carrier = await prisma.withTenantTransaction(orgId, (tx) =>
      tx.carrier.findUniqueOrThrow({ where: { id: carrierId } }),
    );
    expect(sent.to).not.toBe(carrier.primaryContactEmail);
  }, 30000);

  it('when the driver has no email on file, requires a manual one-time recipient and never falls back to the carrier email', async () => {
    const carrierId = await createEligibleCarrier('no-driver-email');
    const { loadId } = await createBookedLoad('no-driver-email');
    await progressToRateConfirmation(loadId, carrierId);

    const driverRes = await adminAgent
      .post(`${API}/carriers/${carrierId}/drivers`)
      .send({ firstName: 'NoEmail', lastName: 'Driver', phone: '555-2222' }) // no email
      .expect(201);

    await adminAgent
      .post(`${API}/loads/${loadId}/dispatch`)
      .send({
        driverName: 'NoEmail Driver',
        driverPhone: '555-2222',
        truckNumber: 'T-2',
        trailerNumber: 'TR-2',
        sourceDriverId: driverRes.body.id,
      })
      .expect(200);

    // --- (4) no driver email -> preview reports null, never the carrier's ---
    const preview = await adminAgent
      .get(`${API}/loads/${loadId}/driver-dispatch-email-preview`)
      .expect(200);
    expect(preview.body.recipientEmail).toBeNull();

    // --- (5) sending with no override is rejected, never silently uses the carrier email ---
    const rejected = await adminAgent
      .post(`${API}/loads/${loadId}/send-driver-dispatch-email`)
      .send({})
      .expect(422);
    expect(rejected.body.error.code).toBe('BUSINESS_RULE_ERROR');

    // --- manual one-time override works and is what actually gets sent ---
    const sendRes = await adminAgent
      .post(`${API}/loads/${loadId}/send-driver-dispatch-email`)
      .send({ manualRecipientEmail: 'manual-override@local-verify-driver.test' })
      .expect(200);
    expect(sendRes.body.recipientEmail).toBe('manual-override@local-verify-driver.test');

    const sent = await lastEmailTo('manual-override@local-verify-driver.test');
    const carrier = await prisma.withTenantTransaction(orgId, (tx) =>
      tx.carrier.findUniqueOrThrow({ where: { id: carrierId } }),
    );
    expect(sent.to).not.toBe(carrier.primaryContactEmail);

    // Never persisted to the Driver record.
    const driverAfter = await prisma.withTenantTransaction(orgId, (tx) =>
      tx.driver.findUniqueOrThrow({ where: { id: driverRes.body.id } }),
    );
    expect(driverAfter.email).toBeNull();

    // An invalid manual email is rejected before anything is sent.
    const before = capturedEmails.length;
    await adminAgent
      .post(`${API}/loads/${loadId}/send-driver-dispatch-email`)
      .send({ manualRecipientEmail: 'not-an-email' })
      .expect(400);
    expect(capturedEmails.length).toBe(before);
  }, 30000);

  it('existing carrier Rate Confirmation email behavior is unchanged: carrier recipient, no attachment', async () => {
    const carrierId = await createEligibleCarrier('regression');
    const { loadId, loadNumber } = await createBookedLoad('regression');
    await adminAgent.post(`${API}/loads/${loadId}/begin-sourcing`).expect(200);
    await adminAgent
      .post(`${API}/loads/${loadId}/assign-carrier`)
      .send({ carrierId, carrierRate: '900.00' })
      .expect(200);

    const carrier = await prisma.withTenantTransaction(orgId, (tx) =>
      tx.carrier.findUniqueOrThrow({ where: { id: carrierId } }),
    );

    await adminAgent
      .post(`${API}/loads/${loadId}/generate-rate-confirmation`)
      .send({ sendEmail: true })
      .expect(200);

    const sent = await lastEmailTo(carrier.primaryContactEmail!);
    expect(sent.subject).toBe(`Rate Confirmation — Load ${loadNumber}`);
    // (15) attachment-less emails remain exactly as before — no attachments field/array at all.
    expect(sent.attachments).toBeUndefined();
  }, 30000);
});
