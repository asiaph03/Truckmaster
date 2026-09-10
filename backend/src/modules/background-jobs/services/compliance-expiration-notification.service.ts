import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';
import { EXPIRABLE_DOCUMENT_CODES } from './carrier-compliance-expiration-sweep.service';

const THRESHOLDS: { days: number; type: NotificationType }[] = [
  { days: 30, type: 'COMPLIANCE_EXPIRING_30_DAY' },
  { days: 15, type: 'COMPLIANCE_EXPIRING_15_DAY' },
  { days: 7, type: 'COMPLIANCE_EXPIRING_7_DAY' },
];

/** Workflow 3 §3.10 — Operations Manager + Compliance (Reviewer), not a single named user (Decision 4). */
const NOTIFICATION_ROLES: MembershipRoleName[] = ['OPERATIONS_MANAGER', 'COMPLIANCE_REVIEWER'];

/**
 * Workflow 3 §3.10 — "each fires once" per threshold per item. Dedup is
 * implemented by checking for an existing `Notification` row keyed on
 * (organization, threshold type, related entity) before creating a new
 * one — the Notification table itself is the source of truth for "have we
 * already fired this," rather than a separate tracking table.
 */
@Injectable()
export class ComplianceExpirationNotificationService {
  private readonly logger = new Logger(ComplianceExpirationNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async loadExpiringDocs(organizationId: string, windowStart: Date, windowEnd: Date) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.document.findMany({
        where: {
          organizationId,
          entityType: 'CARRIER',
          isCurrentVersion: true,
          reviewStatus: 'APPROVED',
          expirationDate: { gte: windowStart, lte: windowEnd },
          documentType: { code: { in: [...EXPIRABLE_DOCUMENT_CODES] } },
        },
        include: { documentType: true },
      }),
    );
  }

  private async loadExpiringInsurance(organizationId: string, windowStart: Date, windowEnd: Date) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.carrierInsurance.findMany({
        where: {
          organizationId,
          expirationDate: { gte: windowStart, lte: windowEnd },
        },
      }),
    );
  }

  /** Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for why each org/threshold/record gets its own transaction. */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    // Monitoring Phase 4A-10 — local to this run() invocation only, see
    // InvitationExpirationSweepService.run() for the full concurrency
    // reasoning. Declared outside both the org and threshold loops so
    // recordsMatched/Succeeded/Failed aggregate across all 3 thresholds
    // and both record types (documents, insurance) for the whole run —
    // never reset per threshold.
    let orgsScanned = 0;
    let recordsMatched = 0;
    let recordsSucceeded = 0;
    let recordsFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      for (const threshold of THRESHOLDS) {
        const windowStart = new Date();
        const windowEnd = new Date();
        windowEnd.setDate(windowEnd.getDate() + threshold.days);

        let docs: Awaited<ReturnType<typeof this.loadExpiringDocs>>;
        try {
          docs = await this.loadExpiringDocs(org.id, windowStart, windowEnd);
        } catch (error) {
          this.logger.error(
            `Compliance expiration notification sweep: failed to load expiring documents for org ${org.id}, threshold ${threshold.days}d: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
          docs = [];
        }

        recordsMatched += docs.length;

        for (const doc of docs) {
          try {
            await this.prisma.withTenantTransaction(org.id, async (tx) => {
              const alreadySent = await tx.notification.findFirst({
                where: {
                  organizationId: org.id,
                  type: threshold.type,
                  relatedEntityType: 'Document',
                  relatedEntityId: doc.id,
                },
              });
              if (alreadySent) return;

              const carrier = await tx.carrier.findFirst({
                where: { id: doc.entityId, organizationId: org.id },
              });
              if (!carrier) return;

              await this.notifications.createForRoles(tx, org.id, NOTIFICATION_ROLES, {
                type: threshold.type,
                relatedEntityType: 'Document',
                relatedEntityId: doc.id,
                message: `${doc.documentType.label} for ${carrier.legalName} expires ${doc.expirationDate!.toISOString().slice(0, 10)} (assignment eligible: ${carrier.assignmentEligible ? 'Yes' : 'No'}).`,
              });

              await this.audit.record(tx, {
                organizationId: org.id,
                action: 'Expiration Notification Sent',
                entityType: 'Document',
                entityId: doc.id,
                newValue: { thresholdDays: threshold.days, carrierId: carrier.id },
                actorType: 'SYSTEM',
              });
            });
            recordsSucceeded++;
          } catch (error) {
            recordsFailed++;
            this.logger.error(
              `Compliance expiration notification sweep: failed for org ${org.id}, document ${doc.id}, threshold ${threshold.days}d: ${
                error instanceof Error ? error.message : String(error)
              }`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        }

        let insuranceRecords: Awaited<ReturnType<typeof this.loadExpiringInsurance>>;
        try {
          insuranceRecords = await this.loadExpiringInsurance(org.id, windowStart, windowEnd);
        } catch (error) {
          this.logger.error(
            `Compliance expiration notification sweep: failed to load expiring insurance for org ${org.id}, threshold ${threshold.days}d: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
          insuranceRecords = [];
        }

        recordsMatched += insuranceRecords.length;

        for (const record of insuranceRecords) {
          try {
            await this.prisma.withTenantTransaction(org.id, async (tx) => {
              const alreadySent = await tx.notification.findFirst({
                where: {
                  organizationId: org.id,
                  type: threshold.type,
                  relatedEntityType: 'CarrierInsurance',
                  relatedEntityId: record.id,
                },
              });
              if (alreadySent) return;

              const carrier = await tx.carrier.findFirst({
                where: { id: record.carrierId, organizationId: org.id },
              });
              if (!carrier) return;

              const coverageLabel =
                record.coverageType === 'AUTO_LIABILITY' ? 'Auto Liability' : 'Cargo';
              await this.notifications.createForRoles(tx, org.id, NOTIFICATION_ROLES, {
                type: threshold.type,
                relatedEntityType: 'CarrierInsurance',
                relatedEntityId: record.id,
                message: `${coverageLabel} insurance for ${carrier.legalName} expires ${record.expirationDate.toISOString().slice(0, 10)} (assignment eligible: ${carrier.assignmentEligible ? 'Yes' : 'No'}).`,
              });

              await this.audit.record(tx, {
                organizationId: org.id,
                action: 'Expiration Notification Sent',
                entityType: 'CarrierInsurance',
                entityId: record.id,
                newValue: { thresholdDays: threshold.days, carrierId: carrier.id },
                actorType: 'SYSTEM',
              });
            });
            recordsSucceeded++;
          } catch (error) {
            recordsFailed++;
            this.logger.error(
              `Compliance expiration notification sweep: failed for org ${org.id}, carrierInsurance ${record.id}, threshold ${threshold.days}d: ${
                error instanceof Error ? error.message : String(error)
              }`,
              error instanceof Error ? error.stack : undefined,
            );
          }
        }
      }
    }

    const summary = `Compliance expiration notification sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }
}
