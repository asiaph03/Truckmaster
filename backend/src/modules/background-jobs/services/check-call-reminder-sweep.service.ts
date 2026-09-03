import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';
import { AppConfig } from '../../../config/configuration';

const IN_TRANSIT_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;

/** Operational Alerts feature — fixed 15-minute lead time for CHECK_CALL_DUE_SOON, ahead of CHECK_CALL_OVERDUE. */
const DUE_SOON_LEAD_MS = 15 * 60 * 1000;

interface SweepDispatchRecord {
  driverName: string;
  sourceDriver: { firstName: string; lastName: string } | null;
}

/**
 * Same precedence rule already used for `assignedDriverName` on
 * `GET /loads` / `GET /loads/search` (LoadService.list /
 * LoadSearchService.search): the live linked Driver's current name wins
 * over the DispatchRecord's own snapshot name. Returns null (never
 * "undefined"/"null" text) when there is no dispatch record at all.
 */
function resolveDriverName(dispatchRecord: SweepDispatchRecord | null): string | null {
  if (!dispatchRecord) return null;
  return dispatchRecord.sourceDriver
    ? `${dispatchRecord.sourceDriver.firstName} ${dispatchRecord.sourceDriver.lastName}`
    : dispatchRecord.driverName;
}

/** "Driver: Jane Smith · Due in 12 min", or just "Due in 12 min" when no driver name is available — never a dangling "Driver: " prefix. */
function buildDetailLine(driverName: string | null, timeText: string): string {
  return driverName ? `Driver: ${driverName} · ${timeText}` : timeText;
}

/**
 * TECHNICAL_ARCHITECTURE.md §10.1 (B1 resolved) — fixed, non-configurable
 * OVERDUE THRESHOLD read from `CHECK_CALL_REMINDER_HOURS` (Decision 3,
 * confirmed at 4 hours). This threshold is unchanged by the Operational
 * Alerts feature — only the SWEEP CADENCE changed (see
 * OPERATIONAL_SWEEP_INTERVAL_MS in background-jobs.constants.ts), so a
 * 15-minute CHECK_CALL_DUE_SOON window is never missed between runs.
 *
 * Per Decision 5: a Load with no `assignedDispatcherId` is silently
 * skipped — no fallback broadcast to every Dispatcher.
 *
 * Dedup (Operational Alerts feature, deliberately different per type):
 *  - CHECK_CALL_OVERDUE: unread-scoped check-before-create — never a
 *    second unread OVERDUE notification for the same Load. Once marked
 *    read, a later sweep is free to recreate it if still overdue.
 *  - CHECK_CALL_DUE_SOON: identical unread-scoped dedup, and is always
 *    superseded (marked read) the moment the Load crosses into OVERDUE —
 *    a Load is never shown as both "due soon" and "overdue" at once.
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
          include: {
            dispatchRecord: {
              include: { sourceDriver: { select: { firstName: true, lastName: true } } },
            },
            checkCalls: true,
          },
        });

        for (const load of loads) {
          if (!load.assignedDispatcherId) continue;

          const lastCheckCallAt = load.checkCalls.reduce<Date | null>(
            (latest, cc) => (!latest || cc.occurredAt > latest ? cc.occurredAt : latest),
            null,
          );
          const lastActivityAt = lastCheckCallAt ?? load.dispatchRecord?.dispatchedAt ?? null;
          if (!lastActivityAt) continue;

          const elapsedMs = Date.now() - lastActivityAt.getTime();
          const driverName = resolveDriverName(load.dispatchRecord);

          if (elapsedMs >= thresholdMs) {
            await this.fireOverdue(
              tx,
              org.id,
              load,
              driverName,
              elapsedMs,
              thresholdMs,
              reminderHours,
            );
          } else if (elapsedMs >= thresholdMs - DUE_SOON_LEAD_MS) {
            await this.fireDueSoon(tx, org.id, load, driverName, elapsedMs, thresholdMs);
          }
        }
      });
    }
  }

  private async fireOverdue(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: { id: string; loadNumber: string; assignedDispatcherId: string | null },
    driverName: string | null,
    elapsedMs: number,
    thresholdMs: number,
    reminderHours: number,
  ): Promise<void> {
    // A Load is never shown as both "due soon" and "overdue" — supersede
    // any outstanding unread due-soon alert the moment it crosses over.
    // Harmless no-op on every subsequent sweep once already superseded.
    await tx.notification.updateMany({
      where: {
        organizationId,
        type: 'CHECK_CALL_DUE_SOON',
        relatedEntityType: 'Load',
        relatedEntityId: load.id,
        read: false,
      },
      data: { read: true },
    });

    const existing = await tx.notification.findFirst({
      where: {
        organizationId,
        type: 'CHECK_CALL_OVERDUE',
        relatedEntityType: 'Load',
        relatedEntityId: load.id,
        read: false,
      },
    });
    if (existing) return;

    const minutesOverdue = Math.floor((elapsedMs - thresholdMs) / 60000);
    await this.notifications.create(tx, organizationId, {
      recipientUserId: load.assignedDispatcherId!,
      type: 'CHECK_CALL_OVERDUE',
      relatedEntityType: 'Load',
      relatedEntityId: load.id,
      message: `Check call overdue — ${load.loadNumber}\n${buildDetailLine(driverName, `${minutesOverdue} min overdue`)}`,
    });

    await this.audit.record(tx, {
      organizationId,
      action: 'Check Call Overdue Reminder Sent',
      entityType: 'Load',
      entityId: load.id,
      newValue: { reminderHours },
      actorType: 'SYSTEM',
    });
  }

  private async fireDueSoon(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: { id: string; loadNumber: string; assignedDispatcherId: string | null },
    driverName: string | null,
    elapsedMs: number,
    thresholdMs: number,
  ): Promise<void> {
    const existing = await tx.notification.findFirst({
      where: {
        organizationId,
        type: 'CHECK_CALL_DUE_SOON',
        relatedEntityType: 'Load',
        relatedEntityId: load.id,
        read: false,
      },
    });
    if (existing) return;

    const minutesUntilDue = Math.ceil((thresholdMs - elapsedMs) / 60000);
    await this.notifications.create(tx, organizationId, {
      recipientUserId: load.assignedDispatcherId!,
      type: 'CHECK_CALL_DUE_SOON',
      relatedEntityType: 'Load',
      relatedEntityId: load.id,
      message: `Check call due — ${load.loadNumber}\n${buildDetailLine(driverName, `Due in ${minutesUntilDue} min`)}`,
    });

    await this.audit.record(tx, {
      organizationId,
      action: 'Check Call Due Soon Reminder Sent',
      entityType: 'Load',
      entityId: load.id,
      actorType: 'SYSTEM',
    });
  }
}
