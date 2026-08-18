import { Injectable } from '@nestjs/common';
import { PodStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';

/**
 * TECHNICAL_ARCHITECTURE.md §6.4 `derivePodStatus` — a faithful port of the
 * locked pseudocode, mirroring `CarrierEligibilityService.recalculate`'s
 * exact shape (§14's "faithful reference implementation" standard,
 * `docs/ARCHITECTURE.md` §11's "recalculate synchronously, persist only on
 * change, audit only on change" convention, already applied twice before
 * for `computeEligibility` and `deriveLoadStatus`).
 *
 * 🔒 LOCKED (Phase 5 sign-off): only `Document` rows with `scanStatus =
 * 'CLEAN'` count toward the milestone — `PENDING`/`INFECTED`/`SCAN_FAILED`
 * never do, regardless of Workflow 7 §7.1's "upload alone counts as
 * received" language, which is read as contrasting with Workflow 3's
 * separate *review* step, not as overriding Decision 10's universal
 * malware-scan gate. Called from `DocumentService.applyScanResult`, never
 * from `initiateUpload` — recalculation only ever happens once a scan
 * result (of any outcome) is known.
 */
@Injectable()
export class LoadPodStatusService {
  constructor(private readonly audit: AuditService) {}

  async recalculatePodStatus(
    tx: Prisma.TransactionClient,
    organizationId: string,
    loadId: string,
  ): Promise<PodStatus> {
    const load = await tx.load.findFirstOrThrow({ where: { id: loadId, organizationId } });

    const deliveryStops = await tx.stop.findMany({
      where: { loadId, organizationId, stopType: 'DELIVERY' },
      select: { id: true },
    });

    const cleanPodDocuments = await tx.document.findMany({
      where: {
        organizationId,
        entityType: 'STOP',
        entityId: { in: deliveryStops.map((s) => s.id) },
        isCurrentVersion: true,
        scanStatus: 'CLEAN',
        documentType: { code: 'POD' },
      },
      select: { entityId: true },
    });
    const stopsWithPod = new Set(cleanPodDocuments.map((d) => d.entityId));

    let podStatus: PodStatus;
    if (stopsWithPod.size === 0) podStatus = 'NOT_RECEIVED';
    else if (stopsWithPod.size < deliveryStops.length) podStatus = 'PARTIAL';
    else podStatus = 'COMPLETE';

    if (podStatus === load.podStatus) return podStatus;

    await tx.load.update({ where: { id: loadId }, data: { podStatus } });

    await this.audit.record(tx, {
      organizationId,
      action: 'POD Milestone Updated',
      entityType: 'Load',
      entityId: loadId,
      previousValue: { podStatus: load.podStatus },
      newValue: { podStatus },
      actorType: 'SYSTEM',
    });

    return podStatus;
  }
}
