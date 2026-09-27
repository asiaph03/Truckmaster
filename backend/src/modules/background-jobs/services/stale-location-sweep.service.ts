import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  evaluateLocationStaleness,
  type LocationStalenessResult,
} from '../../quote-load/utils/location-staleness';

const OPERATIONAL_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;
const ATTENTION_TYPE = 'STALE_LOCATION';

/** "3h 5m" for 185, "45m" for 45 — never "0h 45m". Same convention as EtaRiskSweepService's own helper. */
function formatDurationMinutes(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
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
  currentLocationUpdatedAt: Date | null;
}

/**
 * Needs Attention V2 (B.3) — the second AttentionItem detector.
 * `AttentionType.STALE_LOCATION` only. Structurally identical to
 * `EtaRiskSweepService` (B.2): same operational scope, same
 * `withTenantTransaction`-per-Load discipline, same orphan-resolution
 * pass, same create/update/reactivate/resolve lifecycle keyed on
 * `(organizationId, loadId, type)`. Deliberately does NOT gate on
 * `assignedDispatcherId` — see B.2's own precedent and the B.3 design
 * audit: AttentionItem detection is decoupled from recipient visibility,
 * unlike the older Notification-based sweeps.
 *
 * This detector never writes to `Load` itself (unlike B.2's guarded
 * `currentLocationLat/Lng` write) — it only ever reads
 * `currentLocationUpdatedAt` and writes its own `AttentionItem` row.
 */
@Injectable()
export class StaleLocationSweepService {
  private readonly logger = new Logger(StaleLocationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async loadOperationalLoads(organizationId: string): Promise<OperationalLoad[]> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: { organizationId, status: { in: [...OPERATIONAL_STATUSES] } },
        select: { id: true, loadNumber: true, currentLocationUpdatedAt: true },
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
          `Stale location sweep: failed to load operational loads for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += loads.length;
      const operationalLoadIds = new Set(loads.map((l) => l.id));

      for (const load of loads) {
        const staleness = evaluateLocationStaleness({
          currentLocationUpdatedAt: load.currentLocationUpdatedAt,
        });
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.applyResult(tx, org.id, load, staleness),
          );
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Stale location sweep: failed for org ${org.id}, load ${load.id}. errorType=${errorTypeOf(error)}`,
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
          `Stale location sweep: failed to load existing AttentionItems for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      for (const item of staleActiveItems) {
        if (operationalLoadIds.has(item.loadId)) continue; // handled by the per-load pass above
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) => this.resolveItem(tx, item.id));
        } catch (error) {
          this.logger.error(
            `Stale location sweep: failed to resolve orphaned AttentionItem ${item.id} for org ${org.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Stale location sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
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
    staleness: LocationStalenessResult | null,
  ): Promise<void> {
    const existing = await tx.attentionItem.findUnique({
      where: {
        organizationId_loadId_type: { organizationId, loadId: load.id, type: ATTENTION_TYPE },
      },
    });

    if (!staleness) {
      if (existing && existing.status === 'ACTIVE') {
        await this.resolveItem(tx, existing.id);
      }
      return;
    }

    const title = 'Stale Location';
    const reason = `Location has not been updated in approximately ${formatDurationMinutes(staleness.ageMinutes)}.`;
    const suggestedActions = [{ type: 'VIEW_LOAD' }];
    const metadata = {
      ageMinutes: Math.round(staleness.ageMinutes),
      currentLocationUpdatedAt: load.currentLocationUpdatedAt!.toISOString(),
    };

    if (!existing) {
      await tx.attentionItem.create({
        data: {
          organizationId,
          loadId: load.id,
          type: ATTENTION_TYPE,
          severity: staleness.severity,
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
        newValue: { type: ATTENTION_TYPE, severity: staleness.severity },
        actorType: 'SYSTEM',
      });
      return;
    }

    if (existing.status === 'ACTIVE') {
      await tx.attentionItem.update({
        where: { id: existing.id },
        data: { severity: staleness.severity, title, reason, suggestedActions, metadata },
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
        severity: staleness.severity,
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
      newValue: { type: ATTENTION_TYPE, severity: staleness.severity },
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
