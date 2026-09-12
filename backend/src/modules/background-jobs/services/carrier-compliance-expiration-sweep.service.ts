import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { CarrierEligibilityService } from '../../carrier/services/carrier-eligibility.service';

/**
 * Workflow 3 §3.9 — the document types Workflow 3 names as having an
 * applicable expiration date ("such as MC Authority, Notice of Assignment").
 * W9 is deliberately excluded — Workflow 3's own text never names it as an
 * expiring document type, unlike MC Authority/Notice of Assignment.
 */
export const EXPIRABLE_DOCUMENT_CODES = ['MC_AUTHORITY', 'CARRIER_AGREEMENT'] as const;

/**
 * Monitoring Phase 4A-17 — a class-name-only error identifier, never
 * error.message/.stack. Safe by construction: a JS/TS class name is
 * developer-defined source text, never runtime/user-controlled content.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

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
  private readonly logger = new Logger(CarrierComplianceExpirationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly carrierEligibility: CarrierEligibilityService,
  ) {}

  private async loadStaleDocs(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findMany({
        where: {
          organizationId,
          entityType: 'CARRIER',
          isCurrentVersion: true,
          reviewStatus: 'APPROVED',
          expirationDate: { lt: new Date() },
          documentType: { code: { in: [...EXPIRABLE_DOCUMENT_CODES] } },
        },
      }),
    );
  }

  private async loadActiveCarriers(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.carrier.findMany({
        where: { organizationId, status: 'ACTIVE' },
        select: { id: true },
      }),
    );
  }

  /**
   * Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for
   * why each org/record gets its own transaction. The two passes (document
   * expiry, carrier eligibility recalculation) are now also independent of
   * each other — previously sharing one per-org transaction meant a
   * failure in either pass rolled back the other, which was never an
   * intentional coupling between these two logically separate operations.
   */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    // Monitoring Phase 4A-10 — local to this run() invocation only, see
    // InvitationExpirationSweepService.run() for the full concurrency
    // reasoning. This sweep deliberately does NOT use the generic
    // 4-field shape: it runs two independent passes over two different
    // record types (documents, then carriers), so document and carrier
    // outcomes are tracked and reported separately rather than conflated
    // into one ambiguous "recordsMatched" number.
    let orgsScanned = 0;
    let documentsMatched = 0;
    let documentsSucceeded = 0;
    let documentsFailed = 0;
    let carriersMatched = 0;
    let carriersSucceeded = 0;
    let carriersFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      let staleDocs: Awaited<ReturnType<typeof this.loadStaleDocs>>;
      try {
        staleDocs = await this.loadStaleDocs(org.id);
      } catch (error) {
        this.logger.error(
          `Carrier compliance expiration sweep: failed to load stale documents for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        staleDocs = [];
      }

      documentsMatched += staleDocs.length;

      for (const doc of staleDocs) {
        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
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
          });
          documentsSucceeded++;
        } catch (error) {
          documentsFailed++;
          this.logger.error(
            `Carrier compliance expiration sweep: failed to expire document for org ${org.id}, document ${doc.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }

      let activeCarriers: Awaited<ReturnType<typeof this.loadActiveCarriers>>;
      try {
        activeCarriers = await this.loadActiveCarriers(org.id);
      } catch (error) {
        this.logger.error(
          `Carrier compliance expiration sweep: failed to load active carriers for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      carriersMatched += activeCarriers.length;

      for (const carrier of activeCarriers) {
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.carrierEligibility.recalculate(tx, org.id, carrier.id),
          );
          carriersSucceeded++;
        } catch (error) {
          carriersFailed++;
          this.logger.error(
            `Carrier compliance expiration sweep: failed to recalculate eligibility for org ${org.id}, carrier ${carrier.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary =
      `Carrier compliance expiration sweep summary: orgsScanned=${orgsScanned} ` +
      `documentsMatched=${documentsMatched} documentsSucceeded=${documentsSucceeded} documentsFailed=${documentsFailed} ` +
      `carriersMatched=${carriersMatched} carriersSucceeded=${carriersSucceeded} carriersFailed=${carriersFailed}`;
    if (documentsFailed > 0 || carriersFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }
}
