import { Injectable } from '@nestjs/common';
import { MembershipRoleName } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { parseBusinessDateTime } from '../../../common/timezone/business-timezone';
import { NotFoundError } from '../../../common/errors/app-error';
import { CreateInternalNoteDto } from '../dto/create-internal-note.dto';
import { CreateCommunicationActivityDto } from '../dto/create-communication-activity.dto';
import { redactAuditFinancialFields } from './activity-history-redaction';

export type ActivityTimelineEntry =
  | { type: 'AUDIT'; timestamp: Date; [key: string]: unknown }
  | { type: 'COMMUNICATION'; timestamp: Date; [key: string]: unknown }
  | { type: 'NOTE'; timestamp: Date; [key: string]: unknown };

/**
 * Frontend Phase 7 (Activity History, UI_UX_DESIGN.md §5.4.4, Decision
 * LD-6). Internal Notes and Communication Activity are logged to their own
 * tables only — deliberately NOT also written to AuditLog. The locked
 * layout requires three visually-distinct entry types in one timeline
 * (neutral system events / brand-tinted notes / info-tinted
 * communications); if these two create paths also wrote an AuditLog entry,
 * every note/call would appear twice under two different visual
 * treatments. `getActivityHistory` sources AUDIT-type entries from
 * AuditLog only and NOTE/COMMUNICATION-type entries from their own tables
 * only, with no overlap.
 */
@Injectable()
export class ActivityHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async addInternalNote(
    organizationId: string,
    loadId: string,
    dto: CreateInternalNoteDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      return tx.internalNote.create({
        data: {
          organizationId,
          loadId,
          authorUserId: actingUserId,
          content: dto.content,
        },
      });
    });
  }

  async logCommunicationActivity(
    organizationId: string,
    loadId: string,
    dto: CreateCommunicationActivityDto,
    actingUserId: string,
  ) {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      return tx.communicationActivity.create({
        data: {
          organizationId,
          loadId,
          loggedByUserId: actingUserId,
          activityType: dto.activityType,
          direction: dto.direction,
          contactPerson: dto.contactPerson,
          notes: dto.notes,
          occurredAt: dto.occurredAt ? parseBusinessDateTime(dto.occurredAt) : new Date(),
        },
      });
    });
  }

  /**
   * Load-level audit entries only (entityType: 'Load', entityId: loadId) —
   * Stop-level lifecycle events (arrival/departure/reschedule) are written
   * with entityType: 'Stop' and are out of scope for v1 (approved scope
   * decision). No pagination — matches the house convention that no list
   * endpoint in this codebase paginates.
   */
  async getActivityHistory(
    organizationId: string,
    loadId: string,
    actingUserId: string,
    actingRoles: MembershipRoleName[],
  ): Promise<ActivityTimelineEntry[]> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const load = await tx.load.findFirst({ where: { id: loadId, organizationId } });
      if (!load) throw new NotFoundError('Load not found.');

      const [auditEntries, communications, notes] = await Promise.all([
        tx.auditLog.findMany({ where: { organizationId, entityType: 'Load', entityId: loadId } }),
        tx.communicationActivity.findMany({ where: { organizationId, loadId } }),
        tx.internalNote.findMany({ where: { organizationId, loadId } }),
      ]);

      const redactedAudit = auditEntries.map((entry) =>
        redactAuditFinancialFields(entry, actingRoles, actingUserId, load.createdByUserId),
      );

      const timeline: ActivityTimelineEntry[] = [
        ...redactedAudit.map((entry) => ({
          type: 'AUDIT' as const,
          ...entry,
          timestamp: entry.createdAt,
        })),
        ...communications.map((entry) => ({
          type: 'COMMUNICATION' as const,
          ...entry,
          timestamp: entry.occurredAt,
        })),
        ...notes.map((entry) => ({ type: 'NOTE' as const, ...entry, timestamp: entry.createdAt })),
      ];

      return timeline.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    });
  }
}
