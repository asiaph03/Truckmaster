import type { AttentionSeverity, RiskStatus } from '@prisma/client';

/**
 * Needs Attention V2 (B.9) — MANUAL_RISK_FLAG detector's pure logic.
 *
 * Unlike every other detector, this is not derived from elapsed time or
 * location data: `Load.riskStatus`/`riskReason` are a dispatcher's own
 * judgment, set only via `DispatchTrackingService.setRiskStatus`. This
 * module just mirrors that field into an AttentionItem-shaped result, so
 * wording elsewhere should read as "a dispatcher flagged this load", never
 * "the system detected a risk".
 *
 * Operational-scope gating (DISPATCHED/PICKUP/IN_TRANSIT) is deliberately
 * NOT here — it lives in the sweep service's query, matching every other
 * detector, since it's a property of which Loads get read, not of a single
 * Load's own fields.
 */

export interface ManualRiskFlagInput {
  riskStatus: RiskStatus;
  riskReason: string | null;
}

export interface ManualRiskFlagResult {
  riskStatus: Exclude<RiskStatus, 'NORMAL'>;
  /** The dispatcher's `riskReason`, verbatim. A fallback sentence only when it's missing/blank (can't happen via `setRiskStatus`, which requires it — defensive only). */
  reason: string;
  severity: AttentionSeverity;
}

/** Approved B.9 mapping — no CRITICAL: this is a dispatcher's prediction, not an already-materialized failure. */
const SEVERITY_BY_RISK_STATUS: Record<Exclude<RiskStatus, 'NORMAL'>, AttentionSeverity> = {
  AT_RISK: 'MEDIUM',
  DELAYED: 'HIGH',
};

const FALLBACK_REASON_BY_RISK_STATUS: Record<Exclude<RiskStatus, 'NORMAL'>, string> = {
  AT_RISK: 'A dispatcher marked this load At Risk; no reason was recorded.',
  DELAYED: 'A dispatcher marked this load Delayed; no reason was recorded.',
};

/**
 * Pure and side-effect-free. `NORMAL` never qualifies. Never invents a
 * reason when one exists: a non-blank `riskReason` is returned untouched
 * (no trimming, no truncation, no rewording).
 */
export function evaluateManualRiskFlag(input: ManualRiskFlagInput): ManualRiskFlagResult | null {
  if (input.riskStatus === 'NORMAL') return null;

  const riskStatus = input.riskStatus;
  const hasReason = typeof input.riskReason === 'string' && input.riskReason.trim() !== '';

  return {
    riskStatus,
    reason: hasReason ? (input.riskReason as string) : FALLBACK_REASON_BY_RISK_STATUS[riskStatus],
    severity: SEVERITY_BY_RISK_STATUS[riskStatus],
  };
}
