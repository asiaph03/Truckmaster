import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CarrierService } from '../src/modules/carrier/services/carrier.service';
import { BusinessRuleError } from '../src/common/errors/app-error';
import { EMAIL_SENDER, IEmailSender } from '../src/common/email/email-sender.interface';

/**
 * Phase 2 — real-Postgres concurrency proof for the Organization row lock
 * (EntitlementService's `SELECT ... FOR UPDATE`). A mocked-tx unit test
 * (entitlement.service.spec.ts) can only prove the code calls the lock in
 * the right order — it cannot prove the lock actually serializes two
 * concurrent transactions, since a jest mock has no real transactional
 * semantics. This file is the only real proof of that.
 *
 * Calls CarrierService directly (not via HTTP) — this test proves the
 * service+database concurrency behavior, not the HTTP/auth layer, which is
 * already covered elsewhere.
 *
 * Requires a live PostgreSQL reachable via DATABASE_URL, with migrations
 * already applied:
 *   npm run prisma:migrate:deploy
 *   npm run test:e2e
 */
describe('Entitlement concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let carrierService: CarrierService;

  beforeAll(async () => {
    const captureEmailSender: IEmailSender = { send: async () => undefined };

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
    carrierService = app.get(CarrierService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createOrgWithCarrierLimit(seed: string, maxCarriers: number | null) {
    const user = await prisma.user.create({
      data: {
        email: `entitlement-concurrency-${seed}@trucktms.internal`,
        name: 'Entitlement Concurrency Test User',
        status: 'ACTIVE',
      },
    });
    const org = await prisma.organization.create({
      data: {
        legalName: `Entitlement Concurrency Org ${seed}`,
        addressLine1: '1 Test St',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        primaryContactName: 'Test Contact',
        primaryContactEmail: `contact-${seed}@trucktms.internal`,
        primaryContactPhone: '555-0100',
        createdByUserId: user.id,
        maxCarriers,
      },
    });
    return { user, org };
  }

  function carrierDto(seed: string, suffix: string) {
    return {
      legalName: `Concurrency Carrier ${seed}-${suffix}`,
      mcNumber: `MC-${seed}-${suffix}`,
      dotNumber: `DOT-${seed}-${suffix}`,
      addressLine1: '1 Carrier St',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      primaryContactName: 'Dispatch',
      primaryContactPhone: '555-0200',
      primaryContactEmail: `dispatch-${seed}-${suffix}@trucktms.internal`,
    };
  }

  it(
    'two simultaneous carrier creates against maxCarriers=1 result in exactly one success, ' +
      'one BusinessRuleError rejection, and exactly one carrier persisted',
    async () => {
      const seed = `limit1-${Date.now()}`;
      const { user, org } = await createOrgWithCarrierLimit(seed, 1);

      const results = await Promise.allSettled([
        carrierService.create(org.id, carrierDto(seed, 'a'), user.id),
        carrierService.create(org.id, carrierDto(seed, 'b'), user.id),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BusinessRuleError);

      // Carrier is RLS-protected — count it inside the same tenant-context
      // transaction helper CarrierService itself uses, or Postgres RLS
      // silently filters every row out and the count always reads 0
      // regardless of what was actually persisted (mirrors the existing
      // withOrgContext pattern in rls-tenant-isolation.e2e-spec.ts).
      const persistedCount = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.carrier.count({ where: { organizationId: org.id } }),
      );
      expect(persistedCount).toBe(1);
    },
    30000,
  );

  it(
    'unlimited (maxCarriers=null) allows both concurrent creates to succeed — matches every ' +
      'existing production organization',
    async () => {
      const seed = `unlimited-${Date.now()}`;
      const { user, org } = await createOrgWithCarrierLimit(seed, null);

      const results = await Promise.allSettled([
        carrierService.create(org.id, carrierDto(seed, 'a'), user.id),
        carrierService.create(org.id, carrierDto(seed, 'b'), user.id),
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const persistedCount = await prisma.withTenantTransaction(org.id, (tx) =>
        tx.carrier.count({ where: { organizationId: org.id } }),
      );
      expect(persistedCount).toBe(2);
    },
    30000,
  );
});
