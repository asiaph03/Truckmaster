import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RiskStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../../common/audit/audit.service';
import {
  evaluateManualRiskFlag,
  type ManualRiskFlagResult,
} from '../../quote-load/utils/manual-risk-flag';

const OPERATIONAL_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;
const ATTENTION_TYPE = 'MANUAL_RISK_FLAG';

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

const TITLE_BY_RISK_STATUS: Record<Exclude<RiskStatus, 'NORMAL'>, string> = {
  AT_RISK: 'Dispatcher Flagged: At Risk',
  DELAYED: 'Dispatcher Flagged: Delayed',
};

interface FlaggedLoad {
  id: string;
  loadNumber: string;
  riskStatus: RiskStatus;
  riskReason: string | null;
}

/**
 * Needs Attention V2 (B.9) — the fifth AttentionItem detector.
 * `AttentionType.MANUAL_RISK_FLAG` only. Structurally identical to
 * AppointmentImminentSweepService (B.6): same `DISPATCHED`/`PICKUP`/
 * `IN_TRANSIT` operational scope, same `withTenantTransaction`-per-Load
 * discipline, same orphan-resolution pass, same create/update/reactivate/
 * resolve lifecycle keyed on `(organizationId, loadId, type)`.
 *
 * Deliberately a pure, read-only consumer of `Load.riskStatus`/`riskReason`
 * — it never writes to either field. A Load that already carries a risk
 * flag but has left operational scope (e.g. DELIVERED, where nothing clears
 * the flag) is simply never read, and any ACTIVE item it still has is
 * resolved by the orphan pass below.
 *
 * Unlike APPOINTMENT_IMMINENT_NO_CHECK_CALL, there is intentionally NO
 * suppression against any other detector: a dispatcher's manual judgment is
 * an independent signal that may legitimately coexist with any other ACTIVE
 * item on the same Load (it often explains why another one fired).
 */
@Injectable()
export class ManualRiskFlagSweepService {
  private readonly logger = new Logger(ManualRiskFlagSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async loadFlaggedLoads(organizationId: string): Promise<FlaggedLoad[]> {
    return this.prisma.withTenantTransaction(organizationId, (tx) =>
      tx.load.findMany({
        where: {
          organizationId,
          status: { in: [...OPERATIONAL_STATUSES] },
          riskStatus: { not: 'NORMAL' },
        },
        select: { id: true, loadNumber: true, riskStatus: true, riskReason: true },
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

      let loads: FlaggedLoad[];
      try {
        loads = await this.loadFlaggedLoads(org.id);
      } catch (error) {
        this.logger.error(
          `Manual risk flag sweep: failed to load flagged loads for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      recordsMatched += loads.length;
      const flaggedLoadIds = new Set(loads.map((l) => l.id));

      for (const load of loads) {
        const risk = evaluateManualRiskFlag({
          riskStatus: load.riskStatus,
          riskReason: load.riskReason,
        });
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) =>
            this.applyResult(tx, org.id, load, risk),
          );
          recordsSucceeded++;
        } catch (error) {
          recordsFailed++;
          this.logger.error(
            `Manual risk flag sweep: failed for org ${org.id}, load ${load.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }

      // A Load that is no longer both operational AND flagged — set back to
      // NORMAL, or delivered/closed/cancelled while still carrying a stale
      // flag — no longer appears in `loads` above at all, so any
      // AttentionItem it still has ACTIVE must be resolved here.
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
          `Manual risk flag sweep: failed to load existing AttentionItems for org ${org.id}. errorType=${errorTypeOf(error)}`,
        );
        continue;
      }

      for (const item of staleActiveItems) {
        if (flaggedLoadIds.has(item.loadId)) continue; // handled by the per-load pass above
        try {
          await this.prisma.withTenantTransaction(org.id, (tx) => this.resolveItem(tx, item.id));
        } catch (error) {
          this.logger.error(
            `Manual risk flag sweep: failed to resolve orphaned AttentionItem ${item.id} for org ${org.id}. errorType=${errorTypeOf(error)}`,
          );
        }
      }
    }

    const summary = `Manual risk flag sweep summary: orgsScanned=${orgsScanned} recordsMatched=${recordsMatched} recordsSucceeded=${recordsSucceeded} recordsFailed=${recordsFailed}`;
    if (recordsFailed > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
  }

  private async applyResult(
    tx: Prisma.TransactionClient,
    organizationId: string,
    load: FlaggedLoad,
    risk: ManualRiskFlagResult | null,
  ): Promise<void> {
    const existing = await tx.attentionItem.findUnique({
      where: {
        organizationId_loadId_type: { organizationId, loadId: load.id, type: ATTENTION_TYPE },
      },
    });

    // Defensive: the query already excludes NORMAL loads (the orphan pass is
    // what normally resolves a cleared flag), but the predicate stays the
    // single owner of "does this qualify", so honor its answer here too.
    if (!risk) {
      if (existing && existing.status === 'ACTIVE') {
        await this.resolveItem(tx, existing.id);
      }
      return;
    }

    const title = TITLE_BY_RISK_STATUS[risk.riskStatus];
    const reason = risk.reason;
    const suggestedActions = [{ type: 'VIEW_LOAD' }];
    const metadata = { riskStatus: risk.riskStatus };

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
