/**
 * Operational Alerts feature — the ONE backend-owned definition of "Load
 * Late." Before this, two separate, ephemeral, frontend-only heuristics
 * existed (Dispatch Board Table View's "Overdue" quick filter and
 * CalendarBoard's per-event overdue styling), and they disagreed with
 * each other (see the read-only audit). This function does not replace
 * either of those — they are unrelated, client-side display filters —
 * but no new lateness logic anywhere in the app should invent a third
 * definition; it should call this instead.
 *
 * Deliberately does NOT consider Load.riskStatus (a manual,
 * reason-required dispatcher judgment call — never derived from a
 * timestamp) and does NOT consider Load.currentEta (sparse, manually
 * typed in during a check call, not a live/predictive signal). A stop is
 * late purely because its scheduled appointment has passed while it is
 * still not COMPLETED — never a prediction.
 *
 * Return Product feature — only `stopPurpose: 'STANDARD'` stops are
 * considered, mirroring the identical, already-established filter in
 * `LoadStatusDerivationService.deriveLoadStatus` and
 * `firstPickupDate`/`lastDeliveryDate` (loadDerived.ts) / `pickStopDate`
 * (load-search.service.ts) — a return leg's own appointment must never
 * distort the standard leg's operational signals, exactly as documented
 * on `Stop.stopPurpose` in schema.prisma. `(stopPurpose ?? 'STANDARD')`
 * treats a missing value as STANDARD, same defensive convention used at
 * every other STANDARD-only filter site in this codebase.
 */

export type LateStopType = 'PICKUP' | 'DELIVERY' | 'OTHER';

export interface LatenessStopInput {
  stopType: LateStopType;
  status: 'PENDING' | 'ARRIVED' | 'COMPLETED';
  appointmentDatetime: Date | null;
  sequence: number;
  stopPurpose: 'STANDARD' | 'RETURN';
}

export interface LateStop {
  stopType: LateStopType;
  appointmentDatetime: Date;
}

/**
 * Returns the earliest-sequence STANDARD stop that is late (status !==
 * COMPLETED and appointmentDatetime is in the past relative to `now`), or
 * null if the Load has no late stop. A RETURN-purpose stop is never
 * returned, even if it is itself late. Pure and side-effect-free — no DB
 * access, no AI, no randomness.
 */
export function findLateStop(stops: LatenessStopInput[], now: Date = new Date()): LateStop | null {
  const nowMs = now.getTime();
  const late = stops
    .filter(
      (s): s is LatenessStopInput & { appointmentDatetime: Date } =>
        (s.stopPurpose ?? 'STANDARD') === 'STANDARD' &&
        s.status !== 'COMPLETED' &&
        s.appointmentDatetime !== null &&
        s.appointmentDatetime.getTime() < nowMs,
    )
    .sort((a, b) => a.sequence - b.sequence);

  if (late.length === 0) return null;
  return { stopType: late[0].stopType, appointmentDatetime: late[0].appointmentDatetime };
}
