import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../common/audit/audit.service';

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

const REQUIRED_COMPLIANCE_CODES = ['CARRIER_AGREEMENT', 'W9', 'MC_AUTHORITY'] as const;

/**
 * 🔒 LOCKED (Phase 2 sign-off): for V1, `resultStatus = "Authorized"`
 * (case-insensitive) is the ONLY value that satisfies the FMCSA
 * eligibility condition. `CarrierFmcsaVerification.resultStatus` remains
 * a free-text VARCHAR by design (DATABASE_DESIGN.md §5, no locked enum),
 * so this is a closed-vocabulary check applied to an open-text field —
 * "Conditional" and every other status are treated as NOT acceptable
 * unless a future business decision explicitly changes this rule. Do not
 * broaden this match without an explicit sign-off.
 */
function isAcceptableFmcsaResult(resultStatus: string): boolean {
  return resultStatus.trim().toLowerCase() === 'authorized';
}

/**
 * TECHNICAL_ARCHITECTURE.md §6.5 `computeEligibility` — implemented as a
 * faithful, line-for-line port of the locked pseudocode (§14's "faithful
 * reference implementation" standard applied to every state machine/
 * derived-field function), including its literal double-push of both
 * "Carrier is Blocked" and "Carrier status is not Active" reasons for a
 * Blocked carrier (the two checks are independent, not an if/else).
 *
 * Recalculated synchronously inside the same transaction as any input
 * change (§6.5) — never by a background job for blocking/allowing
 * assignment.
 */
@Injectable()
export class CarrierEligibilityService {
  constructor(private readonly audit: AuditService) {}

  async recalculate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    carrierId: string,
  ): Promise<EligibilityResult> {
    const carrier = await tx.carrier.findFirstOrThrow({ where: { id: carrierId, organizationId } });

    const reasons: string[] = [];

    if (carrier.status === 'BLOCKED') reasons.push('Carrier is Blocked');
    if (carrier.status !== 'ACTIVE') reasons.push('Carrier status is not Active');

    reasons.push(...(await this.computeComplianceReasons(tx, organizationId, carrierId)));

    const eligible = reasons.length === 0;
    const wasEligible = carrier.assignmentEligible;

    await tx.carrier.update({
      where: { id: carrierId },
      data: { assignmentEligible: eligible, ineligibilityReasons: reasons },
    });

    if (eligible !== wasEligible) {
      await this.audit.record(tx, {
        organizationId,
        action: 'Assignment Eligibility Changed',
        entityType: 'Carrier',
        entityId: carrierId,
        previousValue: { assignmentEligible: wasEligible },
        newValue: { assignmentEligible: eligible, reasons },
        actorType: 'SYSTEM',
      });
    }

    return { eligible, reasons };
  }

  /**
   * 🔒 LOCKED (Phase 2 sign-off) — the V1 interpretation of a genuine
   * circularity in Workflow 3 §3.7/§3.8: condition 1 ("Carrier status =
   * ACTIVE") can only ever become true as a RESULT of activation
   * succeeding, so checking it as a precondition would make activation
   * permanently impossible for every carrier. The activation gate
   * therefore checks only the 6 compliance conditions (§3.8 items 2-7).
   * If those pass, the activation action itself (CarrierService.activate)
   * is what flips `Carrier.status` PENDING → ACTIVE; only *after* that
   * transition does the normal `recalculate()` above (which does include
   * condition 1) run and confirm eligibility. This is a locked V1
   * interpretation, not a redesign of the state machine — do not change
   * this split without an explicit sign-off.
   */
  async checkActivationReadiness(
    tx: Prisma.TransactionClient,
    organizationId: string,
    carrierId: string,
  ): Promise<EligibilityResult> {
    const reasons = await this.computeComplianceReasons(tx, organizationId, carrierId);
    return { eligible: reasons.length === 0, reasons };
  }

  private async computeComplianceReasons(
    tx: Prisma.TransactionClient,
    organizationId: string,
    carrierId: string,
  ): Promise<string[]> {
    const reasons: string[] = [];

    const complianceDocs = await tx.document.findMany({
      where: {
        organizationId,
        entityType: 'CARRIER',
        entityId: carrierId,
        isCurrentVersion: true,
        documentType: { code: { in: [...REQUIRED_COMPLIANCE_CODES] } },
      },
      include: { documentType: true },
      orderBy: { uploadedAt: 'desc' },
    });

    for (const code of REQUIRED_COMPLIANCE_CODES) {
      const doc = complianceDocs.find((d) => d.documentType.code === code);
      if (!doc || doc.reviewStatus !== 'APPROVED') {
        reasons.push(`${labelFor(code)} is not approved`);
      }
    }

    const insuranceRecords = await tx.carrierInsurance.findMany({
      where: { organizationId, carrierId },
      include: { coiDocument: true },
    });

    for (const coverageType of ['AUTO_LIABILITY', 'CARGO'] as const) {
      const now = new Date();
      const valid = insuranceRecords.some(
        (record) =>
          record.coverageType === coverageType &&
          record.expirationDate >= now &&
          record.coiDocument.reviewStatus === 'APPROVED',
      );
      if (!valid) {
        reasons.push(
          `${coverageType === 'AUTO_LIABILITY' ? 'Auto Liability' : 'Cargo'} insurance is expired or not approved`,
        );
      }
    }

    const latestFmcsa = await tx.carrierFmcsaVerification.findFirst({
      where: { organizationId, carrierId },
      orderBy: { verificationDate: 'desc' },
    });
    if (!latestFmcsa || !isAcceptableFmcsaResult(latestFmcsa.resultStatus)) {
      reasons.push('FMCSA/SAFER verification is missing or not acceptable');
    }

    return reasons;
  }
}

function labelFor(code: (typeof REQUIRED_COMPLIANCE_CODES)[number]): string {
  switch (code) {
    case 'CARRIER_AGREEMENT':
      return 'Notice of Assignment';
    case 'W9':
      return 'W9';
    case 'MC_AUTHORITY':
      return 'MC Authority';
  }
}
