import type { AttentionSeverity } from '@prisma/client';

/**
 * Needs Attention V2 (B.3) — STALE_LOCATION detector's pure logic.
 *
 * Source of truth is `Load.currentLocationUpdatedAt` only — per the B.3
 * design audit, this is bumped on EVERY Check Call regardless of whether
 * that call carried a city/state (dispatch-tracking.service.ts's
 * logCheckCall()), so it represents "time since last Check Call activity
 * of any kind," a genuinely different clock than `CheckCall.occurredAt`
 * (a real production example showed a 48-minute divergence between the
 * two). Deliberately does NOT read `currentLocationLat/Lng` or any
 * `resolutionStatus` field — this detector is strictly about freshness,
 * never about geocoding success (that remains UNRESOLVED_LOCATION's
 * separate, unimplemented job).
 *
 * `currentLocationUpdatedAt === null` (no Check Call ever logged) is
 * explicitly NOT stale — a freshly-dispatched Load with nothing to be
 * stale about is the existing CHECK_CALL_OVERDUE sweep's responsibility
 * (its own `lastActivityAt` already falls back to `dispatchedAt`).
 */

const STALE_LOCATION_THRESHOLD_MINUTES = 120;

/**
 * Approved B.3 thresholds — deliberately NOT 240 minutes for HIGH, to
 * avoid coinciding exactly with CHECK_CALL_OVERDUE's own 4-hour default
 * and transitioning both detectors to their most urgent tier at the same
 * moment. No CRITICAL tier: production data showed no case supporting a
 * third tier.
 */
const SEVERITY_RULES: { atOrAboveMinutes: number; severity: AttentionSeverity }[] = [
  { atOrAboveMinutes: 180, severity: 'HIGH' },
  { atOrAboveMinutes: 120, severity: 'MEDIUM' },
];

/** `ageMinutes` must already be >= the MEDIUM threshold (the condition only exists once stale). */
export function computeStaleLocationSeverity(ageMinutes: number): AttentionSeverity {
  const rule = SEVERITY_RULES.find((r) => ageMinutes >= r.atOrAboveMinutes);
  // Unreachable in practice (the last rule's threshold matches the
  // caller's own gate), but satisfies the return type without a
  // non-null assertion — same convention as computeEtaRiskSeverity.
  return rule?.severity ?? 'MEDIUM';
}

export interface LocationStalenessInput {
  currentLocationUpdatedAt: Date | null;
  now?: Date;
}

export interface LocationStalenessResult {
  ageMinutes: number;
  severity: AttentionSeverity;
}

/**
 * The full STALE_LOCATION qualification rule. Pure and side-effect-free —
 * no DB access, no geocoding, no external call.
 */
export function evaluateLocationStaleness(
  input: LocationStalenessInput,
): LocationStalenessResult | null {
  if (!input.currentLocationUpdatedAt) return null;

  const now = input.now ?? new Date();
  const ageMinutes = (now.getTime() - input.currentLocationUpdatedAt.getTime()) / 60000;
  if (ageMinutes < STALE_LOCATION_THRESHOLD_MINUTES) return null;

  return { ageMinutes, severity: computeStaleLocationSeverity(ageMinutes) };
}
