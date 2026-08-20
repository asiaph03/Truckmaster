import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';

/**
 * Workflow 3 §3.9 — the document types Workflow 3 names as having an
 * applicable expiration date ("such as MC Authority, Carrier Agreement").
 * W9 is deliberately excluded — Workflow 3's own text never names it as an
 * expiring document type, unlike MC Authority/Carrier Agreement.
 */
export const EXPIRABLE_DOCUMENT_CODES = ['MC_AUTHORITY', 'CARRIER_AGREEMENT'] as const;

/**
 * Closes the real, previously-disclosed correctness gap in
 * `CarrierEligibilityService`'s own comment: `Carrier.assignmentEligible`
 * is a stored field only recalculated "synchronously inside the same
 * transaction as any input change... never by a background job" — meaning
 * a Carrier whose compliance quietly expired with nobody touching its
 * record stays stale-eligible indefinitely without this sweep.
 *
 * Two passes per organization: (1) flip stale `Document.reviewStatus`
 * APPROVED → EXPIRED for the document types above (the `EXPIRED` enum
 * value already existed, unused, since Phase 2); (2) recalculate
 * eligibility for every Active carrier — deliberately ALL of them, not
 * just carriers with a detected new expiration, since
 * `CarrierEligibilityService.recalculate()` is reused completely
 * unmodified and this is the simplest way to also catch newly-expired
 * `CarrierInsurance` records (which have no stored status field to flip —
 * eligibility already checks `expirationDate` live) without duplicating
 * its logic here.
 */
@Injectable()
export class CarrierComplianceExpirationSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierEligibility: CarrierEligibilityService,
  ) {}

  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      await this.prisma.withTenantTransaction(org.id, async (tx) => {
        const staleDocs = await tx.document.findMany({
          where: {
            organizationId: org.id,
            entityType: 'CARRIER',
            isCurrentVersion: true,
            reviewStatus: 'APPROVED',
            expirationDate: { lt: new Date() },
            documentType: { code: { in: [...EXPIRABLE_DOCUMENT_CODES] } },
          },
        });

        for (const doc of staleDocs) {
          await tx.document.update({
            where: { id: doc.id },
            data: { reviewStatus: 'EXPIRED' },
          });

          await this.audit.record(tx, {
            organizationId: org.id,
            action: 'Compliance Item Expired',
            entityType: 'Document',
            entityId: doc.id,
            actorType: 'SYSTEM',
          });
        }

        const activeCarriers = await tx.carrier.findMany({
          where: { organizationId: org.id, status: 'ACTIVE' },
          select: { id: true },
        });
        for (const carrier of activeCarriers) {
          await this.carrierEligibility.recalculate(tx, org.id, carrier.id);
        }
      });
    }
  }
}
