import { Injectable } from '@nestjs/common';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      await this.prisma.withTenantTransaction(org.id, async (tx) => {
        for (const threshold of THRESHOLDS) {
          const windowStart = new Date();
          const windowEnd = new Date();
          windowEnd.setDate(windowEnd.getDate() + threshold.days);

          const docs = await tx.document.findMany({
            where: {
              organizationId: org.id,
              entityType: 'CARRIER',
              isCurrentVersion: true,
              reviewStatus: 'APPROVED',
              expirationDate: { gte: windowStart, lte: windowEnd },
              documentType: { code: { in: [...EXPIRABLE_DOCUMENT_CODES] } },
            },
            include: { documentType: true },
          });

          for (const doc of docs) {
            const alreadySent = await tx.notification.findFirst({
              where: {
                organizationId: org.id,
                type: threshold.type,
                relatedEntityType: 'Document',
                relatedEntityId: doc.id,
              },
            });
            if (alreadySent) continue;

            const carrier = await tx.carrier.findFirst({
              where: { id: doc.entityId, organizationId: org.id },
            });
            if (!carrier) continue;

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
          }

          const insuranceRecords = await tx.carrierInsurance.findMany({
            where: {
              organizationId: org.id,
              expirationDate: { gte: windowStart, lte: windowEnd },
            },
          });

          for (const record of insuranceRecords) {
            const alreadySent = await tx.notification.findFirst({
              where: {
                organizationId: org.id,
                type: threshold.type,
                relatedEntityType: 'CarrierInsurance',
                relatedEntityId: record.id,
              },
            });
            if (alreadySent) continue;

            const carrier = await tx.carrier.findFirst({
              where: { id: record.carrierId, organizationId: org.id },
            });
            if (!carrier) continue;

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
          }
        }
      });
    }
  }
}
