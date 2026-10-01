import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import { evaluateMissingPod, type MissingPodResult } from '../../quote-load/utils/missing-pod-risk';

const SCOPE_STATUSES = ['DELIVERED', 'CLOSED'] as const;
const ATTENTION_TYPE = 'MISSING_POD';

/**
 * Must match `LOAD_STATUS_ADVANCED_ACTION.DELIVERED` in
 * dispatch-tracking.service.ts exactly — duplicated here rather than
 * imported (that map is module-private), same convention B.6 already
 * established for OPERATIONAL_STATUSES. This is the only reliable
 * "delivered at" clock: `Load` has no `deliveredAt` column, but this
 * AuditLog entry is written synchronously, inside the same transaction,
 * at the exact moment the status transitions.
 */
const DELIVERED_TRANSITION_AUDIT_ACTION = 'Load Status Advanced — Delivered';

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function formatAgeHours(hours: number): string {
  const rounded = Math.round(hours);
  const days = Math.floor(rounded / 24);
  const remainderHours = rounded % 24;
  return days > 0 ? `${days}d ${remainderHours}h` : `${remainderHours}h`;
}

interface CandidateLoad {
  id: string;
  loadNumber: string;
  status: string;
  closedAt: Date | null;
  deliveredAuditEntryAt: Date | null;
  hasAnyPodDocument: boolean;
}

/**
 * Needs Attention V2 (B.8) — the fourth AttentionItem detector.
 * `AttentionType.MISSING_POD` only. Unlike B.2/B.3/B.6 (all 15-minute
 * operational-cadence, DISPATCHED/PICKUP/IN_TRANSIT-scoped), this detector
 * operates on a days-scale, post-delivery signal — `DELIVERED`/`CLOSED`
 * only — and runs on the existing DAILY sweep cadence instead
 * (registered in ScheduledJobsWorker alongside the other 4 daily sweeps).
 *
 * 🔒 BUSINESS POLICY — the 48-hour threshold is explicitly NOT evidence-
 * derived (B.8 audit found no load that ever reached `podStatus:
 * COMPLETE`, so there is no successful-turnaround baseline to measure
 * against). See missing-pod-risk.ts's own doc comment for the full
 * reasoning, including why a POD Document row in ANY `scanStatus`
 * (including the intentional, expected Cloudmersive free-tier
 * `SCAN_FAILED` outcome) excludes a Load from this detector — scanStatus
 * itself is never inspected here or in the pure-logic function, only
 * whether a POD Document row exists at all.
 *
 * Same create/update/reactivate/resolve/orphan-resolution lifecycle as
 * B.2/B.3/B.6. No suppression against any other AttentionType — B.8's own
 * audit found this operates in a genuinely distinct, post-delivery scope
 * with no overlap. Not gated on `assignedDispatcherId`, matching every
 * prior detector's precedent.
 */
@Injectable()
export class MissingPodSweepService {
  private readonly logger = new Logger(MissingPodSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async loadCandidates(organizationId: string): Promise<CandidateLoad[]> {
    return this.prisma.withTenantTransaction(organizationId, async (tx) => {
      const loads = await tx.load.findMany({
        where: { organizationId, status: { in: [...SCOPE_STATUSES] } },
        select: {
          id: true,
          loadNumber: true,
          status: true,
          closedAt: true,
          stops: {
            where: { stopType: 'DELIVERY', stopPurpose: 'STANDARD' },
            select: { id: true },
          },
        },
      });

      // Batched — one query for every DELIVERED load's own transition
      // entry, never one query per load.
      const deliveredLoadIds = loads.filter((l) => l.status === 'DELIVERED').map((l) => l.id);
      const auditEntries = deliveredLoadIds.length
        ? await tx.auditLog.findMany({
            where: {
              organizationId,
              entityType: 'Load',
              entityId: { in: deliveredLoadIds },
              action: DELIVERED_TRANSITION_AUDIT_ACTION,
            },
            select: { entityId: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          })
        : [];
      const deliveredAuditEntryByLoadId = new Map<string, Date>();
      for (const entry of auditEntries) {
        // orderBy desc — the first entry seen per loadId is the most recent.
        if (!deliveredAuditEntryByLoadId.has(entry.entityId)) {
          deliveredAuditEntryByLoadId.set(entry.entityId, entry.createdAt);
        }
      }

      // Batched — one query for every candidate's delivery-stop POD
      // documents, never one query per load. ANY scanStatus counts
      // toward "a document exists" (never filtered to CLEAN here, unlike
      // LoadPodStatusService's own podStatus derivation) — see this
      // module's own doc comment.
      const allDeliveryStopIds = loads.flatMap((l) => l.stops.map((s) => s.id));
      const podDocuments = allDeliveryStopIds.length
        ? await tx.document.findMany({
            where: {
              organizationId,
              entityType: 'STOP',
              entityId: { in: allDeliveryStopIds },
              documentType: { code: 'POD' },
            },
            select: { entityId: true },
          })
        : [];
      const stopIdsWithPodDocument = new Set(podDocuments.map((d) => d.entityId));

      return loads.map((l) => ({
        id: l.id,
        loadNumber: l.loadNumber,
        status: l.status,
        closedAt: l.closedAt,
        deliveredAuditEntryAt: deliveredAuditEntryByLoadId.get(l.id) ?? null,
        hasAnyPodDocument: l.stops.some((s) => stopIdsWithPodDocument.has(s.id)),
      }));
    });
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

      let loads: CandidateLoad[];
      try {
        loads = await this.loadCandidates(org.id);
      } catch (error) {
        this.logger.error(
          `Missing POD sweep: failed to load candidates for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += loads.length;
      const scopedLoadIds = new Set(loads.map((l) => l.id));

      for (const load of loads) {
        const risk = evaluateMissingPod({
          status: load.status,
          closedAt: load.closedAt,
          deliveredAuditEntryAt: load.deliveredAuditEntryAt,
          hasAnyPodDocument: load.hasAnyPodDocument,
        });
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.applyResult(tx, org.id, load, risk),
          );
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Missing POD sweep: failed for org ${org.id}, load ${load.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }

      // A Load that has left DELIVERED/CLOSED scope entirely (should be
      // rare/never in practice — there is no transition back out of
      // either status today — but mirrors every other detector's own
      // orphan-resolution pass for consistency and defense-in-depth).
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
          `Missing POD sweep: failed to load existing AttentionItems for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      for (const item of staleActiveItems) {
        if (scopedLoadIds.has(item.loadId)) continue; // handled by the per-load pass above
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) => this.resolveItem(tx, item.id));
        } catch (error) {
          this.logger.error(
            `Missing POD sweep: failed to resolve orphaned AttentionItem ${item.id} for org ${org.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Missing POD sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }

  private async applyResult(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: CandidateLoad,
    risk: MissingPodResult | null,
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

    const title = 'Proof of Delivery Missing';
    const reason = `No POD document has been uploaded ${formatAgeHours(risk.ageHours)} after this Load's ${load.status === 'CLOSED' ? 'closure' : 'delivery'}.`;
    const suggestedActions = [{ type: 'VIEW_LOAD' }];
    const metadata = {
      ageHours: Math.round(risk.ageHours),
      clockBasis: risk.clockBasis,
      loadStatus: load.status,
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
