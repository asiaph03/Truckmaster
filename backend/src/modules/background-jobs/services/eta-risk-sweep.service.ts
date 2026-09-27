import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { evaluateEtaRisk, type EtaRiskResult } from '../../quote-load/utils/eta-risk';
import type { LateStopType } from '../../quote-load/utils/load-lateness';

const OPERATIONAL_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;
const ATTENTION_TYPE = 'ETA_AFTER_APPOINTMENT';

function stopTypeLabel(stopType: LateStopType): string {
  if (stopType === 'PICKUP') return 'Pickup';
  if (stopType === 'DELIVERY') return 'Delivery';
  return 'Stop';
}

/** "1h 18m" for 78, "45m" for 45 — never "0h 45m". */
function formatDurationMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Monitoring convention shared with every other sweep in this codebase —
 * a class-name-only error identifier, never error.message/.stack.
 */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

interface OperationalLoad {
  id: string;
  loadNumber: string;
  currentEta: Date | null;
  stops: {
    stopType: 'PICKUP' | 'DELIVERY' | 'OTHER';
    status: 'PENDING' | 'ARRIVED' | 'COMPLETED';
    appointmentDatetime: Date | null;
    sequence: number;
    stopPurpose: 'STANDARD' | 'RETURN';
  }[];
}

/**
 * Needs Attention V2 (B.2) — the first AttentionItem detector.
 * `AttentionType.ETA_AFTER_APPOINTMENT` only; every other type from the
 * approved capability matrix remains unimplemented. Same
 * `DISPATCHED`/`PICKUP`/`IN_TRANSIT` operational scope and
 * `withTenantTransaction` discipline as
 * CheckCallReminderSweepService/LoadLatenessSweepService — one
 * transaction per Load, so one Load's failure never blocks the rest of
 * the sweep pass. Reuses `evaluateEtaRisk` (quote-load/utils/eta-risk.ts)
 * for all detection/severity logic — this service is purely
 * orchestration + the AttentionItem upsert/resolve lifecycle, no
 * duplicated appointment/lateness rules.
 *
 * Dedup/lifecycle is the row itself, not a check-then-create: the
 * `(organizationId, loadId, type)` unique key means there is at most one
 * AttentionItem row per Load for this type, ever — this sweep upserts it
 * every pass (create → ACTIVE, update-in-place while still ACTIVE,
 * reactivate a RESOLVED row, or resolve an ACTIVE row whose condition
 * cleared). A Load that leaves the operational scope entirely (delivered,
 * closed, cancelled) also gets its lingering ACTIVE item resolved — see
 * the second pass in `run()`.
 */
@Injectable()
export class EtaRiskSweepService {
  private readonly logger = new Logger(EtaRiskSweepService.name);

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
          currentEta: true,
          stops: {
            select: {
              stopType: true,
              status: true,
              appointmentDatetime: true,
              sequence: true,
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
          `ETA risk sweep: failed to load operational loads for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += loads.length;
      const operationalLoadIds = new Set(loads.map((l) => l.id));

      for (const load of loads) {
        const risk = evaluateEtaRisk({ currentEta: load.currentEta, stops: load.stops });
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.applyResult(tx, org.id, load, risk),
          );
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `ETA risk sweep: failed for org ${org.id}, load ${load.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }

      // A Load that has left the operational scope entirely (delivered,
      // closed, cancelled) no longer appears in `loads` above at all —
      // any AttentionItem it still has ACTIVE must be resolved too, or it
      // would linger forever ("auto-disappear when the condition clears"
      // must also cover "the Load itself is no longer active").
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
          `ETA risk sweep: failed to load existing AttentionItems for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      for (const item of staleActiveItems) {
        if (operationalLoadIds.has(item.loadId)) continue; // handled by the per-load pass above
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) => this.resolveItem(tx, item.id));
        } catch (error) {
          this.logger.error(
            `ETA risk sweep: failed to resolve orphaned AttentionItem ${item.id} for org ${org.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `ETA risk sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
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
    risk: EtaRiskResult | null,
  ): Promise<void> {
    const existing = await tx.attentionItem.findUnique({
      where: {
        organizationId_loadId_type: { organizationId, loadId: load.id, type: ATTENTION_TYPE },
      },
    });

    if (!risk) {
      if (existing && existing.status === 'ACTIVE') {
        await this.resolveItem(tx, existing.id);
      }
      return;
    }

    const title = `${stopTypeLabel(risk.stopType)} at Risk`;
    const reason = `ETA is approximately ${formatDurationMinutes(risk.minutesAfter)} after the appointment.`;
    const suggestedActions = [{ type: 'VIEW_LOAD' }];
    const metadata = {
      minutesAfter: risk.minutesAfter,
      appointmentDatetime: risk.appointmentDatetime.toISOString(),
      currentEta: risk.currentEta.toISOString(),
      stopType: risk.stopType,
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
      // Condition is still true — refresh content/severity in place, never
      // a second row (unique key already guarantees this, but this branch
      // is the one that keeps the single row's content current).
      await tx.attentionItem.update({
        where: { id: existing.id },
        data: { severity: risk.severity, title, reason, suggestedActions, metadata },
      });
      return;
    }

    // existing.status === 'RESOLVED' — a new occurrence of the same
    // condition on the same Load. Reactivate rather than create a second
    // row (the unique key forbids a second row regardless).
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
