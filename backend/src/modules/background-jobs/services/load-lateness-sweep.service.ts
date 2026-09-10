import { Injectable, Logger } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { NotificationService } from '../../notification/services/notification.service';
import { findLateStop } from '../../quote-load/utils/load-lateness';
import {
  BUSINESS_TIMEZONE,
  wallClockPartsInZone,
} from '../../../common/timezone/business-timezone';

const OPERATIONAL_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;

/** Org Admins also see operational alerts, alongside the assigned dispatcher (never a replacement for them). */
const ADMIN_VISIBILITY_ROLES: MembershipRoleName[] = ['ADMIN'];

/** "3:00 PM" — time only, no date, always rendered in the business timezone (never server-local). */
function formatTimeOnly(instant: Date): string {
  const { hour: hour24, minute } = wallClockPartsInZone(instant, BUSINESS_TIMEZONE);
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function stopTypeLabel(stopType: 'PICKUP' | 'DELIVERY' | 'OTHER'): string {
  if (stopType === 'PICKUP') return 'Pickup';
  if (stopType === 'DELIVERY') return 'Delivery';
  return 'Stop';
}

/**
 * Operational Alerts feature — reuses `findLateStop` (the single
 * backend-owned "Load Late" definition; see that file's own doc comment)
 * to notify the assigned dispatcher when a Load has a scheduled
 * appointment that has passed while the applicable Stop remains
 * incomplete. Mirrors CheckCallReminderSweepService's structure exactly:
 * one org-scoped `load.findMany` per organization (no N+1), same
 * `DISPATCHED`/`PICKUP`/`IN_TRANSIT` + assigned-dispatcher eligibility
 * gate, same recipient targeting (`assignedDispatcherId`, no fallback
 * broadcast when absent).
 *
 * Dedup, deliberately UNLIKE CheckCallReminderSweepService's
 * re-fire-every-sweep behavior: only creates a new `LOAD_LATE`
 * notification when no UNREAD one already exists for this
 * (Load, LOAD_LATE) pair — prevents a load stuck at its appointment from
 * generating a fresh notification every 15-minute sweep. Once the
 * existing one is marked read, the condition (if still true) is free to
 * fire again on a later sweep.
 */
@Injectable()
export class LoadLatenessSweepService {
  private readonly logger = new Logger(LoadLatenessSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async loadOperationalLoads(organizationId: string) {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: { organizationId, status: { in: [...OPERATIONAL_STATUSES] } },
        include: { stops: true },
      }),
    );
  }

  /** Monitoring Phase 4A-2 — see InvitationExpirationSweepService.run() for why each org/record gets its own transaction. */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    for (const org of orgs) {
      let loads: Awaited<ReturnType<typeof this.loadOperationalLoads>>;
      try {
        loads = await this.loadOperationalLoads(org.id);
      } catch (error) {
        this.logger.error(
          `Load lateness sweep: failed to load operational loads for org ${org.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }

      for (const load of loads) {
        if (!load.assignedDispatcherId) continue;

        const lateStop = findLateStop(load.stops);
        if (!lateStop) continue;

        try {
          await this.prisma.withTenantTransaction(org.id, async (tx) => {
            const existing = await tx.notification.findFirst({
              where: {
                organizationId: org.id,
                type: 'LOAD_LATE',
                relatedEntityType: 'Load',
                relatedEntityId: load.id,
                read: false,
              },
            });
            if (existing) return;

            await this.notifications.createForUserAndRoles(
              tx,
              org.id,
              load.assignedDispatcherId!,
              ADMIN_VISIBILITY_ROLES,
              {
                type: 'LOAD_LATE',
                relatedEntityType: 'Load',
                relatedEntityId: load.id,
                message: `Load late — ${load.loadNumber}\n${stopTypeLabel(lateStop.stopType)} appointment: ${formatTimeOnly(lateStop.appointmentDatetime)}`,
              },
            );

            await this.audit.record(tx, {
              organizationId: org.id,
              action: 'Load Late Notification Sent',
              entityType: 'Load',
              entityId: load.id,
              actorType: 'SYSTEM',
            });
          });
        } catch (error) {
          this.logger.error(
            `Load lateness sweep: failed for org ${org.id}, load ${load.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    }
  }
}
