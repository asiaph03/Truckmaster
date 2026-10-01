import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  evaluateAppointmentImminent,
  type AppointmentImminentResult,
} from '../../quote-load/utils/appointment-risk';
import type { LatenessStopInput } from '../../quote-load/utils/load-lateness';

const OPERATIONAL_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;
const ATTENTION_TYPE = 'APPOINTMENT_IMMINENT_NO_CHECK_CALL';
const SUPPRESSING_TYPE = 'STALE_LOCATION';

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/** "3h 5m" for 185, "45m" for 45 — never "0h 45m". Same convention as the other B.2/B.3 sweeps' own helper. */
function formatDurationMinutes(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

interface OperationalLoad {
  id: string;
  loadNumber: string;
  currentLocationUpdatedAt: Date | null;
  dispatchRecord: { dispatchedAt: Date } | null;
  stops: LatenessStopInput[];
}

/**
 * Needs Attention V2 (B.6) — the third AttentionItem detector.
 * `AttentionType.APPOINTMENT_IMMINENT_NO_CHECK_CALL` only. Structurally
 * identical to EtaRiskSweepService/StaleLocationSweepService (B.2/B.3):
 * same `DISPATCHED`/`PICKUP`/`IN_TRANSIT` operational scope, same
 * `withTenantTransaction`-per-Load discipline, same orphan-resolution
 * pass, same create/update/reactivate/resolve lifecycle keyed on
 * `(organizationId, loadId, type)`. Deliberately does NOT gate on
 * `assignedDispatcherId`, matching B.2/B.3's own precedent.
 *
 * One deliberate addition over B.2/B.3: an explicit suppression rule
 * against STALE_LOCATION (approved design). Both detectors read the same
 * underlying clock (`Load.currentLocationUpdatedAt`), and STALE_LOCATION's
 * own 120-minute floor overlaps with this detector's own 120-minute
 * activity-staleness requirement — so if the Load already has an ACTIVE
 * STALE_LOCATION item, this detector resolves/never creates its own item
 * for that Load, rather than duplicating the same underlying signal. This
 * suppression check reads STALE_LOCATION's own row but never writes to
 * it — B.3 itself is untouched by this file.
 */
@Injectable()
export class AppointmentImminentSweepService {
  private readonly logger = new Logger(AppointmentImminentSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async loadOperationalLoads(organizationId: string): Promise<OperationalLoad[]> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: { organizationId, status: { in: [...OPERATIONAL_STATUSES] } },
        select: {
          id: true,
          loadNumber: true,
          currentLocationUpdatedAt: true,
          dispatchRecord: { select: { dispatchedAt: true } },
          stops: {
            select: {
              sequence: true,
              stopType: true,
              status: true,
              appointmentDatetime: true,
              stopPurpose: true,
            },
          },
        },
      }),
    );
  }

  /** Monitoring Phase 4A-2 convention — see InvitationExpirationSweepService.run() for why each org/record gets its own transaction. */
  async run(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });

    let orgsScanned = 0;
    let recordsMatched = 0;
    let recordsSucceeded = 0;
    let recordsFailed = 0;

    for (const org of orgs) {
      orgsScanned++;

      let loads: OperationalLoad[];
      try {
        loads = await this.loadOperationalLoads(org.id);
      } catch (error) {
        this.logger.error(
          `Appointment imminent sweep: failed to load operational loads for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += loads.length;
      const operationalLoadIds = new Set(loads.map((l) => l.id));

      for (const load of loads) {
        const risk = evaluateAppointmentImminent({
          stops: load.stops,
          currentLocationUpdatedAt: load.currentLocationUpdatedAt,
          dispatchedAt: load.dispatchRecord?.dispatchedAt ?? null,
        });
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.applyResult(tx, org.id, load, risk),
          );
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Appointment imminent sweep: failed for org ${org.id}, load ${load.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }

      // A Load that has left the operational scope entirely (delivered,
      // closed, cancelled) no longer appears in `loads` above at all —
      // any AttentionItem it still has ACTIVE must be resolved too.
      let staleActiveItems: { id: string; loadId: string }[];
      try {
        staleActiveItems = await this.prisma.withTenantTransaction(org.id, (tx) =>
          tx.attentionItem.findMany({
            where: { organizationId: org.id, type: ATTENTION_TYPE, status: 'ACTIVE' },
            select: { id: true, loadId: true },
          }),
        );
      } catch (error) {
        this.logger.error(
          `Appointment imminent sweep: failed to load existing AttentionItems for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      for (const item of staleActiveItems) {
        if (operationalLoadIds.has(item.loadId)) continue; // handled by the per-load pass above
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) => this.resolveItem(tx, item.id));
        } catch (error) {
          this.logger.error(
            `Appointment imminent sweep: failed to resolve orphaned AttentionItem ${item.id} for org ${org.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Appointment imminent sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }

  private async applyResult(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: OperationalLoad,
    risk: AppointmentImminentResult | null,
  ): Promise<void> {
    const existing = await tx.attentionItem.findUnique({
      where: {
        organizationId_loadId_type: { organizationId, loadId: load.id, type: ATTENTION_TYPE },
      },
    });

    // ACTIVE STALE_LOCATION intentionally takes precedence over this
    // detector, to avoid two overlapping inactivity alerts for the same
    // underlying stale-location condition — read-only against
    // STALE_LOCATION's own row, never written to. If STALE_LOCATION is
    // already ACTIVE for this Load, APPOINTMENT_IMMINENT_NO_CHECK_CALL
    // never creates/updates, and resolves its own ACTIVE item if one
    // exists.
    const suppressingItem = await tx.attentionItem.findUnique({
      where: {
        organizationId_loadId_type: {
          organizationId,
          loadId: load.id,
          type: SUPPRESSING_TYPE,
        },
      },
    });
    const isSuppressed = suppressingItem?.status === 'ACTIVE';

    if (!risk || isSuppressed) {
      if (existing && existing.status === 'ACTIVE') {
        await this.resolveItem(tx, existing.id);
      }
      return;
    }

    const title = 'Appointment Imminent — No Recent Check-In';
    const reason = `Appointment is in approximately ${formatDurationMinutes(risk.minutesUntilAppointment)}, and the last known activity was approximately ${formatDurationMinutes(risk.minutesSinceLastActivity)} ago.`;
    const suggestedActions = [{ type: 'VIEW_LOAD' }];
    const metadata = {
      minutesUntilAppointment: Math.round(risk.minutesUntilAppointment),
      appointmentDatetime: risk.appointmentDatetime.toISOString(),
      stopType: risk.stopType,
      minutesSinceLastActivity: Math.round(risk.minutesSinceLastActivity),
      lastActivitySource: risk.lastActivitySource,
    };

    if (!existing) {
      await tx.attentionItem.create({
        data: {
          organizationId,
          loadId: load.id,
          type: ATTENTION_TYPE,
          severity: risk.severity,
          status: 'ACTIVE',
          title,
          reason,
          suggestedActions,
          metadata,
        },
      });
      await this.audit.record(tx, {
        organizationId,
        action: 'Attention Item Detected',
        entityType: 'Load',
        entityId: load.id,
        newValue: { type: ATTENTION_TYPE, severity: risk.severity },
        actorType: 'SYSTEM',
      });
      return;
    }

    if (existing.status === 'ACTIVE') {
      await tx.attentionItem.update({
        where: { id: existing.id },
        data: { severity: risk.severity, title, reason, suggestedActions, metadata },
      });
      return;
    }

    // existing.status === 'RESOLVED' — a new occurrence of the same
    // condition on the same Load. Reactivate rather than create a
    // second row (the unique key forbids a second row regardless).
    await tx.attentionItem.update({
      where: { id: existing.id },
      data: {
        status: 'ACTIVE',
        severity: risk.severity,
        title,
        reason,
        suggestedActions,
        metadata,
        detectedAt: new Date(),
        resolvedAt: null,
      },
    });
    await this.audit.record(tx, {
      organizationId,
      action: 'Attention Item Reactivated',
      entityType: 'Load',
      entityId: load.id,
      newValue: { type: ATTENTION_TYPE, severity: risk.severity },
      actorType: 'SYSTEM',
    });
  }

  private async resolveItem(tx: Prisma.TransactionClient, attentionItemId: string): Promise<void> {
    await tx.attentionItem.update({
      where: { id: attentionItemId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
  }
}
