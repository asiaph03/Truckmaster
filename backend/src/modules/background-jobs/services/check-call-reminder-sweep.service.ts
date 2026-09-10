import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipRoleName, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';
import { AppConfig } from '../../../config/configuration';

const IN_TRANSIT_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;

/** Org Admins also see operational alerts, alongside the assigned dispatcher (never a replacement for them). */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

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
  private readonly logger = new Logger(CheckCallReminderSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService<AppConfig>,
  ) {}

  private async loadInTransitLoads(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: { organizationId, status: { in: [...IN_TRANSIT_STATUSES] } },
        include: {
          dispatchRecord: {
            include: { sourceDriver: { select: { firstName: true, lastName: true } } },
          },
          checkCalls: true,
        },
      }),
    );
  }

  /** Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for why each org/record gets its own transaction. */
  async run(): Promise<void> {
    const reminderHours = this.config.get('checkCallReminderHours', { infer: true })!;
    const thresholdMs = reminderHours * 60 * 60 * 1000;
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    // Monitoring Phase 4A-10 — local to this run() invocation only, see
    // InvitationExpirationSweepService.run() for the full concurrency
    // reasoning. recordsMatched counts every load the query returns;
    // recordsSucceeded/recordsFailed count only loads that pass the
    // existing pre-transaction eligibility gates below (assigned
    // dispatcher, known last-activity time, within the reminder window)
    // and actually reach a transaction attempt — so
    // recordsSucceeded + recordsFailed may legitimately be less than
    // recordsMatched, and that gap is exactly explained by those gates.
    let orgsScanned = 0;
    let recordsMatched = 0;
    let recordsSucceeded = 0;
    let recordsFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      let loads: Awaited<ReturnType<typeof this.loadInTransitLoads>>;
      try {
        loads = await this.loadInTransitLoads(org.id);
      } catch (error) {
        this.logger.error(
          `Check-call reminder sweep: failed to load in-transit loads for org ${org.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }

      recordsMatched += loads.length;

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
        if (elapsedMs < thresholdMs - DUE_SOON_LEAD_MS) continue;

        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
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
            } else {
              await this.fireDueSoon(tx, org.id, load, driverName, elapsedMs, thresholdMs);
            }
          });
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Check-call reminder sweep: failed for org ${org.id}, load ${load.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }

    const summary = `Check-call reminder sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
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
    await this.notifications.createForUserAndRoles(
      tx,
      organizationId,
      load.assignedDispatcherId!,
      ADMIN_VISIBILITY_ROLES,
      {
        type: 'CHECK_CALL_OVERDUE',
        relatedEntityType: 'Load',
        relatedEntityId: load.id,
        message: `Check call overdue — ${load.loadNumber}\n${buildDetailLine(driverName, `${minutesOverdue} min overdue`)}`,
      },
    );

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
    await this.notifications.createForUserAndRoles(
      tx,
      organizationId,
      load.assignedDispatcherId!,
      ADMIN_VISIBILITY_ROLES,
      {
        type: 'CHECK_CALL_DUE_SOON',
        relatedEntityType: 'Load',
        relatedEntityId: load.id,
        message: `Check call due — ${load.loadNumber}\n${buildDetailLine(driverName, `Due in ${minutesUntilDue} min`)}`,
      },
    );

    await this.audit.record(tx, {
      organizationId,
      action: 'Check Call Due Soon Reminder Sent',
      entityType: 'Load',
      entityId: load.id,
      actorType: 'SYSTEM',
    });
  }
}
