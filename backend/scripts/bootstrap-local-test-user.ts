/**
 * LOCAL TEST ENVIRONMENT ONLY — creates the minimum Organization/User/
 * OrganizationMembership/MembershipRole rows needed to log into a freshly
 * migrated, otherwise-empty database. There is no self-serve signup and
 * no seed step that does this (see the Rate Confirmation manual-test
 * investigation) — organization creation normally requires an existing
 * Platform Super Admin, which a fresh DB has none of. This script bypasses
 * that only by inserting rows directly, not by adding a new API surface.
 *
 * Run BEFORE `npm run prisma:apply-rls` — organization_membership/
 * membership_role are RLS-protected, and inserting via a plain
 * PrismaClient (no app.current_org_id session variable set) after RLS is
 * applied would be rejected.
 *
 * Idempotent: if the email already exists, reports it and makes no
 * changes rather than creating a duplicate.
 *
 * Run: npx ts-node -T scripts/bootstrap-local-test-user.ts
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const EMAIL = 'local-test@truckmaster.local';
const PASSWORD = 'LocalTest123!';
const BCRYPT_COST_FACTOR = 12; // matches PasswordService

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    console.log(`User ${EMAIL} already exists (id=${existing.id}) — no changes made.`);
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId: existing.id },
      include: { organization: true, roles: true },
    });
    if (membership) {
      console.log(
        `Existing membership: organizationId=${membership.organizationId}, ` +
          `status=${membership.status}, roles=${membership.roles.map((r) => r.role).join(',')}`,
      );
    } else {
      console.log('WARNING: user exists but has no membership — investigate before testing.');
    }
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_COST_FACTOR);

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash,
      name: 'Local Test User',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  const organization = await prisma.organization.create({
    data: {
      legalName: 'Local Test Org',
      addressLine1: '1 Test St',
      city: 'Test City',
      state: 'TX',
      zip: '75001',
      country: 'US',
      primaryContactName: 'Local Test User',
      primaryContactEmail: EMAIL,
      primaryContactPhone: '555-000-0000',
      status: 'ACTIVE',
      createdByUserId: user.id,
    },
  });

  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });

  await prisma.membershipRole.create({
    data: { organizationId: organization.id, membershipId: membership.id, role: 'ADMIN' },
  });

  console.log('Bootstrap complete.');
  console.log(`User: ${EMAIL} (id=${user.id})`);
  console.log(`Organization: ${organization.legalName} (id=${organization.id})`);
  console.log(`Membership: ACTIVE, role=ADMIN`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
