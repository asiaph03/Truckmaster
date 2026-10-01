import type { AttentionSeverity } from '@prisma/client';
import { findApplicableAppointmentStop } from './eta-risk';
import type { LatenessStopInput, LateStopType } from './load-lateness';

/**
 * Needs Attention V2 (B.6) — APPOINTMENT_IMMINENT_NO_CHECK_CALL detector's
 * pure logic.
 *
 * Reuses `findApplicableAppointmentStop` (eta-risk.ts) for the established
 * stop-selection mechanics (PENDING, STANDARD-purpose, closest-to-now,
 * tie-broken by sequence) — unmodified, per the approved B.6 design. That
 * helper alone is not sufficient here: it picks whichever appointment is
 * closest in *absolute* distance to `now`, which can select an
 * already-PAST appointment (confirmed against real production data —
 * LOAD-000118 selected a stop whose appointment was 425 minutes in the
 * past). B.6 is explicitly forward-looking ("imminent"), so this module
 * adds its own `appointmentDatetime > now` filter on top.
 */

/** Approved B.6 thresholds. */
const APPOINTMENT_WITHIN_MINUTES = 180;
const ACTIVITY_STALE_MINUTES = 120;
const HIGH_SEVERITY_WITHIN_MINUTES = 60;

export type LastActivitySource = 'CHECK_CALL' | 'DISPATCH';

export interface AppointmentImminentInput {
  stops: LatenessStopInput[];
  /** `Load.currentLocationUpdatedAt` — the primary activity clock, per the approved design (never `CheckCall.occurredAt`, which can be backdated). */
  currentLocationUpdatedAt: Date | null;
  /** `DispatchRecord.dispatchedAt` — fallback clock when no Check Call has ever been logged yet. */
  dispatchedAt: Date | null;
  now?: Date;
}

export interface AppointmentImminentResult {
  stopType: LateStopType;
  appointmentDatetime: Date;
  minutesUntilAppointment: number;
  minutesSinceLastActivity: number;
  lastActivitySource: LastActivitySource;
  severity: AttentionSeverity;
}

/**
 * The full APPOINTMENT_IMMINENT_NO_CHECK_CALL qualification rule. Pure and
 * side-effect-free — no DB access, no AttentionItem/STALE_LOCATION
 * awareness (that suppression lives in the sweep service, since it
 * requires reading another AttentionItem row, not pure Load/Stop data).
 *
 * Never guesses: a missing appointment, or a Load with neither a Check
 * Call nor a DispatchRecord, simply does not qualify — no field here is
 * invented.
 */
export function evaluateAppointmentImminent(
  input: AppointmentImminentInput,
): AppointmentImminentResult | null {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  const applicable = findApplicableAppointmentStop(input.stops, now);
  if (!applicable) return null;

  const appointmentMs = applicable.appointmentDatetime.getTime();
  if (appointmentMs <= nowMs) return null; // must be strictly future — see this module's own doc comment above

  const minutesUntilAppointment = (appointmentMs - nowMs) / 60000;
  if (minutesUntilAppointment > APPOINTMENT_WITHIN_MINUTES) return null;

  const lastActivityAt = input.currentLocationUpdatedAt ?? input.dispatchedAt;
  if (!lastActivityAt) return null; // no clock at all (no Check Call, no DispatchRecord) — never guess
  const lastActivitySource: LastActivitySource = input.currentLocationUpdatedAt
    ? 'CHECK_CALL'
    : 'DISPATCH';

  const minutesSinceLastActivity = (nowMs - lastActivityAt.getTime()) / 60000;
  if (minutesSinceLastActivity < ACTIVITY_STALE_MINUTES) return null;

  const severity: AttentionSeverity =
    minutesUntilAppointment <= HIGH_SEVERITY_WITHIN_MINUTES ? 'HIGH' : 'MEDIUM';

  return {
    stopType: applicable.stopType,
    appointmentDatetime: applicable.appointmentDatetime,
    minutesUntilAppointment,
    minutesSinceLastActivity,
    lastActivitySource,
    severity,
  };
}
