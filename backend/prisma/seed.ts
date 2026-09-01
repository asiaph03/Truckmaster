import { PrismaClient } from '@prisma/client';

/**
 * System-default DocumentTypeDefinition rows (DATABASE_DESIGN.md §7,
 * Decision Log D13) — organizationId=null means "available to every
 * organization." Seeded at deploy time, per the doc's explicit
 * instruction; organizations may add their own additional rows on top of
 * these via the (Admin-only, Stage 6 B3) custom-type endpoints.
 *
 * requiresReview=true only for the four Workflow 3 §3.6/§3.8 compliance
 * gate types (Carrier Agreement, W9, COI, MC Authority) — every other
 * type (including Factoring NOA, which Workflow 3 §3.11 explicitly
 * excludes from eligibility) defaults to review_status=NOT_APPLICABLE
 * per TECHNICAL_ARCHITECTURE.md §8.5.
 *
 * category matches the two groupings PRD §6.3 describes: operational/
 * load-lifecycle documents (Rate Confirmation, BOL, POD, receipts,
 * photos, settlement) vs. carrier compliance documents.
 */
const SYSTEM_DOCUMENT_TYPES = [
  { code: 'W9', label: 'W9', category: 'CARRIER_COMPLIANCE', requiresReview: true },
  {
    code: 'COI',
    label: 'Certificate of Insurance',
    category: 'CARRIER_COMPLIANCE',
    requiresReview: true,
  },
  {
    code: 'CARRIER_AGREEMENT',
    label: 'Notice of Assignment',
    category: 'CARRIER_COMPLIANCE',
    requiresReview: true,
  },
  {
    code: 'MC_AUTHORITY',
    label: 'MC Authority',
    category: 'CARRIER_COMPLIANCE',
    requiresReview: true,
  },
  {
    code: 'FACTORING_NOA',
    label: 'Factoring Notice of Assignment',
    category: 'CARRIER_COMPLIANCE',
    requiresReview: false,
  },
  {
    code: 'RATE_CONFIRMATION',
    label: 'Rate Confirmation',
    category: 'LOAD',
    requiresReview: false,
  },
  { code: 'BOL', label: 'Bill of Lading', category: 'LOAD', requiresReview: false },
  { code: 'POD', label: 'Proof of Delivery', category: 'LOAD', requiresReview: false },
  { code: 'POP', label: 'Proof of Pickup', category: 'LOAD', requiresReview: false },
  { code: 'LUMPER_RECEIPT', label: 'Lumper Receipt', category: 'LOAD', requiresReview: false },
  { code: 'SCALE_TICKET', label: 'Scale Ticket', category: 'LOAD', requiresReview: false },
  {
    code: 'ACCESSORIAL_RECEIPT',
    label: 'Accessorial Receipt',
    category: 'LOAD',
    requiresReview: false,
  },
  {
    code: 'DELIVERY_DAMAGE_PHOTO',
    label: 'Delivery/Damage Photo',
    category: 'LOAD',
    requiresReview: false,
  },
  { code: 'SETTLEMENT', label: 'Settlement', category: 'LOAD', requiresReview: false },
  // Phase 6 — Invoice PDF documents (Workflow 8, Document entityType=INVOICE,
  // already anticipated in DocumentEntityType since Phase 2). Not seeded
  // until now since no Invoice model existed to attach one to.
  { code: 'INVOICE', label: 'Invoice', category: 'LOAD', requiresReview: false },
] as const;

/**
 * Phase 6 — system-default ChargeTypeDefinition rows (DATABASE_DESIGN.md
 * §14, Decision Log D9/D13), mirroring SYSTEM_DOCUMENT_TYPES's exact
 * pattern: organizationId=null = available to every organization;
 * organizations may add their own custom types on top via the
 * (Admin-only, Decision Log B3) charge-type management endpoints. Code
 * list taken verbatim from DATABASE_DESIGN.md §14's ChargeTypeDefinition
 * field notes.
 */
const SYSTEM_CHARGE_TYPES = [
  { code: 'LINEHAUL', label: 'Linehaul' },
  { code: 'FUEL_SURCHARGE', label: 'Fuel Surcharge' },
  { code: 'DETENTION', label: 'Detention' },
  { code: 'LUMPER', label: 'Lumper' },
  { code: 'LAYOVER', label: 'Layover' },
  { code: 'TONU', label: 'TONU (Truck Ordered Not Used)' },
  { code: 'ADDITIONAL_STOP', label: 'Additional Stop' },
  { code: 'REDELIVERY', label: 'Redelivery' },
  // Return Product feature — deliberately distinct from REDELIVERY (a
  // second delivery attempt) rather than reusing it, so charge-type
  // reporting doesn't conflate the two different root causes.
  { code: 'RETURN_FREIGHT', label: 'Return Freight' },
  { code: 'OTHER', label: 'Other Accessorial' },
] as const;

const prisma = new PrismaClient();

async function main() {
  for (const type of SYSTEM_DOCUMENT_TYPES) {
    const existing = await prisma.documentTypeDefinition.findFirst({
      where: { organizationId: null, code: type.code },
    });
    if (existing) {
      continue;
    }
    await prisma.documentTypeDefinition.create({
      data: {
        organizationId: null,
        code: type.code,
        label: type.label,
        category: type.category,
        requiresReview: type.requiresReview,
        isSystemDefault: true,
      },
    });
  }

  for (const type of SYSTEM_CHARGE_TYPES) {
    const existing = await prisma.chargeTypeDefinition.findFirst({
      where: { organizationId: null, code: type.code },
    });
    if (existing) {
      continue;
    }
    await prisma.chargeTypeDefinition.create({
      data: {
        organizationId: null,
        code: type.code,
        label: type.label,
        isSystemDefault: true,
      },
    });
  }
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
