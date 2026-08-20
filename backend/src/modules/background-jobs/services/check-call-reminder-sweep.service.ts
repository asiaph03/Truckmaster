import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';
import { AppConfig } from '../../../config/configuration';

const IN_TRANSIT_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;

/**
 * TECHNICAL_ARCHITECTURE.md §10.1 (B1 resolved) — fixed, non-configurable
 * interval read from `CHECK_CALL_REMINDER_HOURS` (Decision 3, confirmed at
 * 4 hours). Unlike the compliance-expiration notifications, no "fires
 * once" language exists for this job in any locked doc — it re-fires each
 * sweep cycle for as long as a Load remains overdue, matching a recurring-
 * reminder semantic rather than a one-time alert (a disclosed
 * interpretation, not literally spelled out).
 *
 * Per Decision 5: a Load with no `assignedDispatcherId` is silently
 * skipped — no fallback broadcast to every Dispatcher.
 */
@Injectable()
export class CheckCallReminderSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  async run(): Promise<void> {
    const reminderHours = this.config.get('checkCallReminderHours', { infer: true })!;
    const thresholdMs = reminderHours * 60 * 60 * 1000;
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      await this.prisma.withTenantTransaction(org.id, async (tx) => {
        const loads = await tx.load.findMany({
          where: { organizationId: org.id, status: { in: [...IN_TRANSIT_STATUSES] } },
          include: { dispatchRecord: true, checkCalls: true },
        });

        for (const load of loads) {
          if (!load.assignedDispatcherId) continue;

          const lastCheckCallAt = load.checkCalls.reduce<Date | null>(
            (latest, cc) => (!latest || cc.occurredAt > latest ? cc.occurredAt : latest),
            null,
          );
          const lastActivityAt = lastCheckCallAt ?? load.dispatchRecord?.dispatchedAt ?? null;
          if (!lastActivityAt) continue;

          if (Date.now() - lastActivityAt.getTime() <= thresholdMs) continue;

          await this.notifications.create(tx, org.id, {
            recipientUserId: load.assignedDispatcherId,
            type: 'CHECK_CALL_OVERDUE',
            relatedEntityType: 'Load',
            relatedEntityId: load.id,
            message: `Load ${load.loadNumber} has gone quiet — no check call in over ${reminderHours} hours.`,
          });

          await this.audit.record(tx, {
            organizationId: org.id,
            action: 'Check Call Overdue Reminder Sent',
            entityType: 'Load',
            entityId: load.id,
            actorType: 'SYSTEM',
          });
        }
      });
    }
  }
}
