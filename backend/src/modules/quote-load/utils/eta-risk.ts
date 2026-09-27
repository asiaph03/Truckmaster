import type { LatenessStopInput, LateStopType } from './load-lateness';
import type { AttentionSeverity } from '@prisma/client';

/**
 * Needs Attention V2 (B.2) — ETA_AFTER_APPOINTMENT detector's pure logic.
 * A sibling to `findLateStop`, not a fork of it: `findLateStop` answers
 * "is anything ALREADY late" (appointment strictly in the past); this
 * answers a different, predictive question — "what is the operationally
 * relevant appointment to compare the Load's current ETA against," which
 * must NOT be gated on "already passed" the way `findLateStop` is, since a
 * risk alert needs to fire *before* the appointment passes.
 *
 * B.2 correctness review — earliest-sequence-wins was tried first and
 * rejected: `DispatchTrackingService.recordArrival`/`recordDeparture`
 * (dispatch-tracking.service.ts) address a Stop purely by its own
 * `sequence` and its own current `status`, with NO check that any
 * earlier-sequence stop has already been completed — so it is entirely
 * possible, per the actual production write path, for a later stop to be
 * ARRIVED/COMPLETED while an earlier one sits PENDING with a long-stale
 * appointment (a forgotten/late status update, not a data error). Picking
 * strictly by sequence would anchor the ETA comparison to that stale
 * stop and produce a nonsensical, noisy "critically late" alert for a
 * Load that is actually on schedule for its real next stop.
 *
 * Fix: among PENDING (not yet ARRIVED — an ARRIVED stop's own risk is
 * already resolved, whether it was on time or not, so it is excluded
 * entirely, not just deprioritized), STANDARD-purpose stops with an
 * appointment, pick whichever appointment is CLOSEST to `now` — the one
 * the Load is actually approaching or just missed — tie-broken by
 * sequence for determinism. This naturally skips a stale, long-forgotten
 * earlier appointment once a later stop's appointment is closer to the
 * present moment, while still correctly picking the soonest upcoming stop
 * when nothing has been touched yet (the common, unremarkable case).
 */
export function findApplicableAppointmentStop(
  stops: LatenessStopInput[],
  now: Date = new Date(),
): { stopType: LateStopType; appointmentDatetime: Date } | null {
  const nowMs = now.getTime();
  const candidates = stops.filter(
    (s): s is LatenessStopInput & { appointmentDatetime: Date } =>
      (s.stopPurpose ?? 'STANDARD') === 'STANDARD' &&
      s.status === 'PENDING' &&
      s.appointmentDatetime !== null,
  );

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const diffA = Math.abs(a.appointmentDatetime.getTime() - nowMs);
    const diffB = Math.abs(b.appointmentDatetime.getTime() - nowMs);
    if (diffA !== diffB) return diffA - diffB;
    return a.sequence - b.sequence;
  });

  return {
    stopType: candidates[0].stopType,
    appointmentDatetime: candidates[0].appointmentDatetime,
  };
}

/**
 * Approved Phase A/B.2 thresholds — deliberately a small, standalone table
 * for this one AttentionType only (not a generic multi-type severity
 * engine; that remains future scope per the approved design, introduced
 * only once a second magnitude-based detector actually needs it). Ordered
 * highest-first so the first matching rule wins.
 */
const ETA_RISK_SEVERITY_THRESHOLDS: { atOrAboveMinutes: number; severity: AttentionSeverity }[] = [
  { atOrAboveMinutes: 60, severity: 'CRITICAL' },
  { atOrAboveMinutes: 15, severity: 'HIGH' },
  { atOrAboveMinutes: 0, severity: 'MEDIUM' },
];

/** `minutesAfter` must already be a positive magnitude (the condition only exists when ETA is after the appointment). */
export function computeEtaRiskSeverity(minutesAfter: number): AttentionSeverity {
  const rule = ETA_RISK_SEVERITY_THRESHOLDS.find((r) => minutesAfter >= r.atOrAboveMinutes);
  // Unreachable in practice (the last rule's threshold is 0, and this
  // function is only ever called with a strictly-positive magnitude), but
  // satisfies the return type without a non-null assertion.
  return rule?.severity ?? 'MEDIUM';
}

export interface EtaRiskInput {
  currentEta: Date | null;
  stops: LatenessStopInput[];
  now?: Date;
}

export interface EtaRiskResult {
  stopType: LateStopType;
  appointmentDatetime: Date;
  currentEta: Date;
  minutesAfter: number;
  severity: AttentionSeverity;
}

/**
 * The full ETA_AFTER_APPOINTMENT qualification rule, per the approved B.2
 * scope: an applicable appointment must exist, a current ETA must exist
 * (never invented/inferred — read directly from `Load.currentEta`), and
 * the ETA must be strictly later than that appointment. Pure and
 * side-effect-free — no DB access, no geocoding, no external call.
 */
export function evaluateEtaRisk(input: EtaRiskInput): EtaRiskResult | null {
  if (!input.currentEta) return null;

  const applicable = findApplicableAppointmentStop(input.stops, input.now);
  if (!applicable) return null;

  const diffMs = input.currentEta.getTime() - applicable.appointmentDatetime.getTime();
  if (diffMs <= 0) return null;

  const minutesAfter = Math.ceil(diffMs / 60000);
  return {
    stopType: applicable.stopType,
    appointmentDatetime: applicable.appointmentDatetime,
    currentEta: input.currentEta,
    minutesAfter,
    severity: computeEtaRiskSeverity(minutesAfter),
  };
}
