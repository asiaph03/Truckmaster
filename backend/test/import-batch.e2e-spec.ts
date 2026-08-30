import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/modules/identity/services/password.service';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

import { withCsrf } from './support/csrf-agent';

type SuperAgentTest = ReturnType<typeof request.agent>;

const API = '/api/v1';

/**
 * Bulk CSV/Excel Import (PRD.md §1.4, §6.9, §10.1, §13) end-to-end proof.
 * Approved technical design + Final Decisions. Covers: all 8 entity types,
 * valid/invalid rows, Customer soft duplicate + acknowledgment, Carrier
 * hard duplicate, child-parent resolution (zero/multiple matches),
 * partial failure, commit idempotency/resumability, the authorization
 * matrix, cross-tenant isolation + RLS, mapping persistence, pagination,
 * CSV and XLSX parsing, file/row limits, and audit records.
 *
 * Requires the same setup as every other e2e spec file:
 *   npm run prisma:migrate:deploy
 *   npm run prisma:apply-rls
 *   npm run prisma:seed
 *   npm run test:e2e
 */
describe('Bulk CSV/Excel Import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sentEmails: { to: string; subject: string; body: string }[];

  const superAdminEmail = 'import-suite-super-admin@trucktms.internal';
  const superAdminPassword = 'SuperAdminPass123';

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
        name: 'Import Suite Platform Super Admin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        passwordHash: await passwordService.hash(superAdminPassword),
      },
    });
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
    throw new Error(`No email found for ${to} within ${timeoutMs}ms`);
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

    const adminEmail = `admin-${seed}@import-test.test`;
    const salesEmail = `sales-${seed}@import-test.test`;
    const dispatcherEmail = `dispatcher-${seed}@import-test.test`;
    const accountingEmail = `accounting-${seed}@import-test.test`;
    const opsManagerEmail = `opsmgr-${seed}@import-test.test`;
    const reviewerEmail = `reviewer-${seed}@import-test.test`;

    const createRes = await superAdminAgent
      .post(`${API}/platform/organizations`)
      .send({
        legalName: `Import Test Org ${seed}`,
        addressLine1: '1 Main St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Org Admin',
        primaryContactEmail: adminEmail,
        primaryContactPhone: '555-0100',
      })
      .expect(201);
    const organizationId: string = createRes.body.organization.id;

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

    await adminAgent
      .post(`${API}/memberships/invite`)
      .send({ email: opsManagerEmail, roles: ['OPERATIONS_MANAGER'] })
      .expect(201);
    const opsManagerAgent = await activateAndLogin(opsManagerEmail, 'OpsManagerPass123');

    await adminAgent
      .post(`${API}/memberships/invite`)
      .send({ email: reviewerEmail, roles: ['COMPLIANCE_REVIEWER'] })
      .expect(201);
    const reviewerAgent = await activateAndLogin(reviewerEmail, 'ReviewerPass123');

    return {
      organizationId,
      adminAgent,
      salesAgent,
      dispatcherAgent,
      accountingAgent,
      opsManagerAgent,
      reviewerAgent,
    };
  }

  async function createCarrier(
    agent: SuperAgentTest,
    seed: string,
  ): Promise<{ id: string; legalName: string }> {
    const legalName = `Import Test Carrier ${seed}`;
    const res = await agent
      .post(`${API}/carriers`)
      .send({
        legalName,
        mcNumber: `MC-IMP-${seed}`,
        dotNumber: `DOT-IMP-${seed}`,
        addressLine1: '5 Dock Rd',
        city: 'Memphis',
        state: 'TN',
        zip: '38103',
        primaryContactName: 'Carrier Dispatch',
        primaryContactPhone: '555-0300',
        primaryContactEmail: `dispatch-${seed}@import-carrier.test`,
      })
      .expect(201);
    return { id: res.body.id, legalName };
  }

  async function buildXlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  async function uploadAndConfirm(
    agent: SuperAgentTest,
    entityType: string,
    fileName: string,
    fileFormat: 'CSV' | 'XLSX',
    fileBuffer: Buffer,
  ) {
    const createRes = await agent
      .post(`${API}/import-batches`)
      .send({ entityType, fileName, fileFormat })
      .expect(201);
    const importBatchId: string = createRes.body.importBatch.id;
    const uploadUrl: string = createRes.body.uploadUrl;

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': fileFormat === 'CSV' ? 'text/csv' : 'application/octet-stream' },
      body: fileBuffer as unknown as BodyInit,
    });

    const confirmRes = await agent
      .post(`${API}/import-batches/${importBatchId}/confirm-upload`)
      .expect(201);
    return {
      importBatchId,
      headers: confirmRes.body.headers,
      suggestedMapping: confirmRes.body.suggestedMapping,
    };
  }

  async function waitForBatchStatus(
    agent: SuperAgentTest,
    importBatchId: string,
    expected: string[],
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await agent.get(`${API}/import-batches/${importBatchId}`).expect(200);
      if (expected.includes(res.body.status)) return res.body;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Import batch ${importBatchId} did not reach ${expected.join('/')} within ${timeoutMs}ms`,
    );
  }

  describe('Customer import', () => {
    it('imports valid rows and reports one invalid row (row-level validation, never silently dropped)', async () => {
      const org = await setUpOrganization('cust-basic');
      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        'Acme Inc,1 Main St,Dallas,TX,75201,Jane Doe,jane@acme.test,555-1000\n' +
        ',2 Other St,Austin,TX,73301,No Name,noname@example.test,555-2000\n';

      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER',
        'customers.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      expect(suggestedMapping['Legal Name']).toBe('legalName');

      const mappingRes = await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);
      expect(mappingRes.body.validRowCount).toBe(1);
      expect(mappingRes.body.invalidRowCount).toBe(1);
      expect(mappingRes.body.columnMapping).toEqual(suggestedMapping); // mapping persistence

      const rowsRes = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows?status=INVALID`)
        .expect(200);
      expect(rowsRes.body.items).toHaveLength(1);
      expect(rowsRes.body.items[0].errors).toEqual(
        expect.arrayContaining([expect.stringContaining('legalName')]),
      );

      await org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`).expect(201);
      const finalBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(finalBatch.importedRowCount).toBe(1);
      expect(finalBatch.skippedRowCount).toBe(0);
      expect(finalBatch.failedRowCount).toBe(0);

      const customers = await prisma.withTenantTransaction(org.organizationId, (tx) =>
        tx.customer.findMany({
          where: { organizationId: org.organizationId, legalName: 'Acme Inc' },
        }),
      );
      expect(customers).toHaveLength(1);

      // Audit records: batch-level + the real per-entity event, both present.
      const auditActions = await prisma.withTenantTransaction(org.organizationId, (tx) =>
        tx.auditLog.findMany({
          where: {
            organizationId: org.organizationId,
            entityId: { in: [importBatchId, customers[0].id] },
          },
          select: { action: true },
        }),
      );
      expect(auditActions.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'Import Batch Created',
          'Import Batch Committed',
          'Import Batch Completed',
          'Customer Created',
        ]),
      );
    }, 30000);

    it('shows a soft duplicate warning at Preview and only imports after acknowledgment', async () => {
      const org = await setUpOrganization('cust-dup');
      await org.adminAgent
        .post(`${API}/customers`)
        .send({
          legalName: 'Duplicate Target Inc',
          billingAddressLine1: '1 Main St',
          billingCity: 'Dallas',
          billingState: 'TX',
          billingZip: '75201',
          primaryContactName: 'Existing Contact',
          primaryContactEmail: 'existing@duplicate.test',
          primaryContactPhone: '555-9999',
        })
        .expect(201);

      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        'Duplicate Target Inc,9 Different St,Houston,TX,77002,New Contact,new@duplicate.test,555-1111\n';
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER',
        'dup.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);

      const rowsRes = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows`)
        .expect(200);
      expect(rowsRes.body.items[0].status).toBe('VALID');
      expect(rowsRes.body.items[0].duplicateWarning).not.toBeNull();
      const rowId = rowsRes.body.items[0].id;

      // Commit WITHOUT acknowledgment first — row must be skipped, never silently imported.
      await org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`).expect(201);
      const skippedBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(skippedBatch.skippedRowCount).toBe(1);
      expect(skippedBatch.importedRowCount).toBe(0);

      // Acknowledge, then re-commit (idempotent resume — only the still-eligible row is processed).
      await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/rows/${rowId}`)
        .send({ acknowledgeDuplicate: true })
        .expect(200);
      await org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`).expect(201);
      const finalBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(finalBatch.importedRowCount).toBe(1);

      const customers = await prisma.withTenantTransaction(org.organizationId, (tx) =>
        tx.customer.findMany({
          where: { organizationId: org.organizationId, legalName: 'Duplicate Target Inc' },
        }),
      );
      expect(customers).toHaveLength(2); // the pre-existing one + the acknowledged import — no accidental double-import of the SAME row.
    }, 30000);
  });

  describe('Carrier import — hard duplicate, no override', () => {
    it('blocks a row with a colliding MC/DOT number at validation time, as an error not a warning', async () => {
      const org = await setUpOrganization('carrier-dup');
      const existing = await createCarrier(org.adminAgent, 'existing');

      const csv =
        'Legal Name,MC Number,DOT Number,Address Line 1,City,State,Zip,Primary Contact Name,Primary Contact Phone,Primary Contact Email\n' +
        `Colliding Carrier LLC,MC-IMP-existing,DOT-IMP-existing,9 Dock Rd,Memphis,TN,38103,Dispatch,555-4000,dispatch@colliding.test\n` +
        'New Carrier LLC,MC-NEW-1,DOT-NEW-1,9 Dock Rd,Memphis,TN,38103,Dispatch,555-4001,dispatch@new.test\n';
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CARRIER',
        'carriers.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      const mappingRes = await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);
      expect(mappingRes.body.invalidRowCount).toBe(1);
      expect(mappingRes.body.validRowCount).toBe(1);

      const invalidRows = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows?status=INVALID`)
        .expect(200);
      expect(invalidRows.body.items[0].errors[0]).toContain('already exists');
      expect(invalidRows.body.items[0].duplicateWarning).toBeNull(); // hard block, not a warning

      await org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`).expect(201);
      const finalBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(finalBatch.importedRowCount).toBe(1); // only the non-colliding row
      void existing;
    }, 30000);
  });

  describe('Child-entity parent resolution', () => {
    it('resolves the parent by exact case-insensitive legal name and imports Driver/Truck/Trailer/CarrierContact/CustomerContact/CustomerLocation', async () => {
      const org = await setUpOrganization('children');
      const carrier = await createCarrier(org.adminAgent, 'parent');
      const customerRes = await org.adminAgent
        .post(`${API}/customers`)
        .send({
          legalName: 'Parent Customer Inc',
          billingAddressLine1: '1 Main St',
          billingCity: 'Dallas',
          billingState: 'TX',
          billingZip: '75201',
          primaryContactName: 'Contact',
          primaryContactEmail: 'contact@parentcustomer.test',
          primaryContactPhone: '555-5000',
        })
        .expect(201);
      const customerId = customerRes.body.id;

      // Driver — exact case-insensitive match on the carrier's legal name.
      const driverCsv = `Carrier Legal Name,First Name,Last Name,Phone\n${carrier.legalName.toUpperCase()},Jane,Doe,555-6000\n`;
      const driverImport = await uploadAndConfirm(
        org.adminAgent,
        'DRIVER',
        'drivers.csv',
        'CSV',
        Buffer.from(driverCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${driverImport.importBatchId}/mapping`)
        .send({ columnMapping: driverImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${driverImport.importBatchId}/commit`)
        .expect(201);
      const driverBatch = await waitForBatchStatus(org.adminAgent, driverImport.importBatchId, [
        'COMPLETE',
      ]);
      expect(driverBatch.importedRowCount).toBe(1);

      const drivers = await prisma.withTenantTransaction(org.organizationId, (tx) =>
        tx.driver.findMany({
          where: { organizationId: org.organizationId, carrierId: carrier.id },
        }),
      );
      expect(drivers).toHaveLength(1);

      // Truck
      const truckCsv = `Carrier Legal Name,Unit Number,Truck Type\n${carrier.legalName},T-100,DRY_VAN\n`;
      const truckImport = await uploadAndConfirm(
        org.adminAgent,
        'TRUCK',
        'trucks.csv',
        'CSV',
        Buffer.from(truckCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${truckImport.importBatchId}/mapping`)
        .send({ columnMapping: truckImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${truckImport.importBatchId}/commit`)
        .expect(201);
      expect(
        (await waitForBatchStatus(org.adminAgent, truckImport.importBatchId, ['COMPLETE']))
          .importedRowCount,
      ).toBe(1);

      // Trailer
      const trailerCsv = `Carrier Legal Name,Unit Number,Trailer Type\n${carrier.legalName},TR-100,REEFER\n`;
      const trailerImport = await uploadAndConfirm(
        org.adminAgent,
        'TRAILER',
        'trailers.csv',
        'CSV',
        Buffer.from(trailerCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${trailerImport.importBatchId}/mapping`)
        .send({ columnMapping: trailerImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${trailerImport.importBatchId}/commit`)
        .expect(201);
      expect(
        (await waitForBatchStatus(org.adminAgent, trailerImport.importBatchId, ['COMPLETE']))
          .importedRowCount,
      ).toBe(1);

      // Carrier Contact
      const carrierContactCsv = `Carrier Legal Name,Name,Role\n${carrier.legalName},Ops Contact,DISPATCH\n`;
      const carrierContactImport = await uploadAndConfirm(
        org.adminAgent,
        'CARRIER_CONTACT',
        'carrier-contacts.csv',
        'CSV',
        Buffer.from(carrierContactCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${carrierContactImport.importBatchId}/mapping`)
        .send({ columnMapping: carrierContactImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${carrierContactImport.importBatchId}/commit`)
        .expect(201);
      expect(
        (await waitForBatchStatus(org.adminAgent, carrierContactImport.importBatchId, ['COMPLETE']))
          .importedRowCount,
      ).toBe(1);

      // Customer Contact
      const customerContactCsv = `Customer Legal Name,Name,Role\nParent Customer Inc,Billing Contact,BILLING\n`;
      const customerContactImport = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER_CONTACT',
        'customer-contacts.csv',
        'CSV',
        Buffer.from(customerContactCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${customerContactImport.importBatchId}/mapping`)
        .send({ columnMapping: customerContactImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${customerContactImport.importBatchId}/commit`)
        .expect(201);
      expect(
        (
          await waitForBatchStatus(org.adminAgent, customerContactImport.importBatchId, [
            'COMPLETE',
          ])
        ).importedRowCount,
      ).toBe(1);

      // Customer Location
      const customerLocationCsv = `Customer Legal Name,Name,Address Line 1,City,State,Zip,Location Type\nParent Customer Inc,Main DC,1 Warehouse Way,Dallas,TX,75201,PICKUP\n`;
      const customerLocationImport = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER_LOCATION',
        'customer-locations.csv',
        'CSV',
        Buffer.from(customerLocationCsv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${customerLocationImport.importBatchId}/mapping`)
        .send({ columnMapping: customerLocationImport.suggestedMapping })
        .expect(200);
      await org.adminAgent
        .post(`${API}/import-batches/${customerLocationImport.importBatchId}/commit`)
        .expect(201);
      expect(
        (
          await waitForBatchStatus(org.adminAgent, customerLocationImport.importBatchId, [
            'COMPLETE',
          ])
        ).importedRowCount,
      ).toBe(1);

      void customerId;
    }, 60000);

    it('marks a row INVALID for zero matches and for multiple matches on the parent legal name', async () => {
      const org = await setUpOrganization('parent-ambiguous');
      const carrierA = await createCarrier(org.adminAgent, 'dup-a');
      // A second carrier with the exact same legal name — a real, if unusual, possibility.
      await org.adminAgent
        .post(`${API}/carriers`)
        .send({
          legalName: carrierA.legalName,
          mcNumber: 'MC-IMP-dup-b',
          dotNumber: 'DOT-IMP-dup-b',
          addressLine1: '9 Dock Rd',
          city: 'Memphis',
          state: 'TN',
          zip: '38103',
          primaryContactName: 'Dispatch',
          primaryContactPhone: '555-7000',
          primaryContactEmail: 'dispatch-dup-b@import-carrier.test',
        })
        .expect(201);

      const csv =
        `Carrier Legal Name,First Name,Last Name,Phone\n` +
        `${carrierA.legalName},Multi,Match,555-8000\n` +
        `Nonexistent Carrier LLC,Zero,Match,555-8001\n`;
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'DRIVER',
        'ambiguous-drivers.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      const mappingRes = await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);
      expect(mappingRes.body.invalidRowCount).toBe(2);
      expect(mappingRes.body.validRowCount).toBe(0);

      const invalidRows = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows?status=INVALID`)
        .expect(200);
      const errors = invalidRows.body.items.flatMap((r: { errors: string[] }) => r.errors);
      expect(errors.some((e: string) => e.includes('2 carriers found'))).toBe(true);
      expect(errors.some((e: string) => e.includes('No carrier found'))).toBe(true);
    }, 30000);
  });

  describe('XLSX parsing', () => {
    it('parses an .xlsx file identically to the equivalent CSV', async () => {
      const org = await setUpOrganization('xlsx');
      const buffer = await buildXlsxBuffer(
        [
          'Legal Name',
          'Billing Address Line 1',
          'Billing City',
          'Billing State',
          'Billing Zip',
          'Primary Contact Name',
          'Primary Contact Email',
          'Primary Contact Phone',
        ],
        [
          [
            'Xlsx Customer Inc',
            '1 Main St',
            'Dallas',
            'TX',
            '75201',
            'Jane',
            'jane@xlsx.test',
            '555-1000',
          ],
        ],
      );
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER',
        'customers.xlsx',
        'XLSX',
        buffer,
      );
      const mappingRes = await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);
      expect(mappingRes.body.validRowCount).toBe(1);

      await org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`).expect(201);
      const finalBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(finalBatch.importedRowCount).toBe(1);
    }, 30000);
  });

  describe('File and row limits', () => {
    it('rejects a file with more rows than the maximum at confirm-upload', async () => {
      const org = await setUpOrganization('row-limit');
      const rows = Array.from(
        { length: 5001 },
        (_, i) => `Row ${i},1 Main St,Dallas,TX,75201,C,c${i}@test.test,555-0000`,
      );
      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        rows.join('\n') +
        '\n';

      const createRes = await org.adminAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CUSTOMER', fileName: 'huge.csv', fileFormat: 'CSV' })
        .expect(201);
      const importBatchId: string = createRes.body.importBatch.id;
      const uploadUrl: string = createRes.body.uploadUrl;
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/csv' },
        body: Buffer.from(csv, 'utf-8'),
      });

      const confirmRes = await org.adminAgent.post(
        `${API}/import-batches/${importBatchId}/confirm-upload`,
      );
      expect(confirmRes.status).toBe(400); // ValidationError
      expect(confirmRes.body.error.message).toContain('5000');
    }, 30000);
  });

  describe('Authorization matrix', () => {
    it('a Dispatcher-only agent cannot create a CUSTOMER import batch (Customer role set excludes Dispatcher)', async () => {
      const org = await setUpOrganization('authz-cust');
      await org.dispatcherAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CUSTOMER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(403);
    }, 30000);

    it('a Sales/Booking-only agent cannot create a CARRIER import batch (Carrier role set excludes Sales/Booking)', async () => {
      const org = await setUpOrganization('authz-carrier');
      await org.salesAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CARRIER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(403);
    }, 30000);

    it('a Compliance Reviewer (additive-only role) cannot create any import batch', async () => {
      const org = await setUpOrganization('authz-reviewer');
      await org.reviewerAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CUSTOMER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(403);
      await org.reviewerAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CARRIER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(403);
    }, 30000);

    it('a Dispatcher CAN create a CARRIER import batch (in the Carrier role set)', async () => {
      const org = await setUpOrganization('authz-dispatcher-ok');
      await org.dispatcherAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CARRIER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(201);
    }, 30000);

    it('an Accounting agent CAN create a CUSTOMER import batch (in the Customer role set)', async () => {
      const org = await setUpOrganization('authz-accounting-ok');
      await org.accountingAgent
        .post(`${API}/import-batches`)
        .send({ entityType: 'CUSTOMER', fileName: 'f.csv', fileFormat: 'CSV' })
        .expect(201);
    }, 30000);
  });

  describe('Pagination', () => {
    it('paginates the rows endpoint', async () => {
      const org = await setUpOrganization('pagination');
      const rows = Array.from(
        { length: 5 },
        (_, i) => `Page Customer ${i},1 Main St,Dallas,TX,75201,C,page${i}@test.test,555-0000`,
      );
      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        rows.join('\n') +
        '\n';
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER',
        'page.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);

      const page1 = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows?page=1&pageSize=2`)
        .expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(5);

      const page3 = await org.adminAgent
        .get(`${API}/import-batches/${importBatchId}/rows?page=3&pageSize=2`)
        .expect(200);
      expect(page3.body.items).toHaveLength(1);
    }, 30000);
  });

  describe('Commit concurrency', () => {
    it('two near-simultaneous commit requests never both succeed — only one enqueues a job, against real Postgres', async () => {
      const org = await setUpOrganization('commit-race');
      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        'Race Customer Inc,1 Main St,Dallas,TX,75201,C,race@test.test,555-0000\n';
      const { importBatchId, suggestedMapping } = await uploadAndConfirm(
        org.adminAgent,
        'CUSTOMER',
        'race.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );
      await org.adminAgent
        .patch(`${API}/import-batches/${importBatchId}/mapping`)
        .send({ columnMapping: suggestedMapping })
        .expect(200);

      const [first, second] = await Promise.allSettled([
        org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`),
        org.adminAgent.post(`${API}/import-batches/${importBatchId}/commit`),
      ]);

      const results = [first, second].map((r) => (r.status === 'fulfilled' ? r.value.status : -1));
      // Exactly one of the two concurrent requests transitions the batch;
      // the other observes updateMany affect 0 rows and gets a clean 400,
      // never a second enqueued job.
      expect(results.filter((s) => s === 201)).toHaveLength(1);
      expect(results.filter((s) => s === 400)).toHaveLength(1);

      const finalBatch = await waitForBatchStatus(org.adminAgent, importBatchId, ['COMPLETE']);
      expect(finalBatch.importedRowCount).toBe(1);

      // If a second job had been enqueued, it would have double-imported
      // the same row — assert exactly one Customer record exists.
      const customers = await prisma.withTenantTransaction(org.organizationId, (tx) =>
        tx.customer.findMany({
          where: { organizationId: org.organizationId, legalName: 'Race Customer Inc' },
        }),
      );
      expect(customers).toHaveLength(1);
    }, 30000);
  });

  describe('Cross-tenant isolation and RLS', () => {
    it("one organization's import batches and rows are never visible to another, at the app layer and the RLS layer", async () => {
      const orgA = await setUpOrganization('cross-a');
      const orgB = await setUpOrganization('cross-b');

      const csv =
        'Legal Name,Billing Address Line 1,Billing City,Billing State,Billing Zip,Primary Contact Name,Primary Contact Email,Primary Contact Phone\n' +
        'Cross Tenant Inc,1 Main St,Dallas,TX,75201,C,cross@test.test,555-0000\n';
      const { importBatchId } = await uploadAndConfirm(
        orgA.adminAgent,
        'CUSTOMER',
        'cross.csv',
        'CSV',
        Buffer.from(csv, 'utf-8'),
      );

      // App layer: org B cannot see org A's batch at all.
      await orgB.adminAgent.get(`${API}/import-batches/${importBatchId}`).expect(404);
      const orgBList = await orgB.adminAgent.get(`${API}/import-batches`).expect(200);
      expect(orgBList.body.find((b: { id: string }) => b.id === importBatchId)).toBeUndefined();

      // RLS layer: a raw query scoped to org B's context returns nothing for org A's row.
      const wrongTenantRows = await prisma.withTenantTransaction(
        orgB.organizationId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT * FROM import_batch WHERE id = ${importBatchId}::uuid`,
      );
      expect(wrongTenantRows).toHaveLength(0);

      const ownTenantRows = await prisma.withTenantTransaction(
        orgA.organizationId,
        (tx) =>
          tx.$queryRaw<unknown[]>`SELECT * FROM import_batch WHERE id = ${importBatchId}::uuid`,
      );
      expect(ownTenantRows.length).toBeGreaterThan(0);

      const noContextRows = await prisma.$queryRaw<
        unknown[]
      >`SELECT * FROM import_batch WHERE id = ${importBatchId}::uuid`;
      expect(noContextRows).toHaveLength(0);
    }, 30000);
  });
});
