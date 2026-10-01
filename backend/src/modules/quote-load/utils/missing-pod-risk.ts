import type { AttentionSeverity } from '@prisma/client';

/**
 * Needs Attention V2 (B.8) — MISSING_POD detector's pure logic.
 *
 * 🔒 BUSINESS POLICY, not evidence-derived (B.8 audit) — the 48-hour
 * threshold below was explicitly chosen because no load in production has
 * ever reached `podStatus: COMPLETE`, so there is no successful-turnaround
 * baseline anywhere to measure "late" against. Do not treat this number as
 * calibrated from data; it is a stated policy default only.
 *
 * The B.8 audit found that of the real (non-test-fixture) candidate
 * population, over half had a POD document already uploaded but stuck in
 * `SCAN_FAILED` — an intentional, expected outcome of the Cloudmersive
 * free-tier file-size override (confirmed business behavior, not a
 * defect). A naive `podStatus != COMPLETE` check conflates "never
 * uploaded" with "uploaded but scan-blocked," which would mislabel over
 * half the real population. This function therefore takes
 * `hasAnyPodDocument` — true the instant ANY POD Document row exists for
 * the load's standard delivery stop(s), in ANY `scanStatus` (`CLEAN`,
 * `SCAN_FAILED`, or otherwise) — and never inspects `scanStatus` itself.
 * Determining "a document row exists" is the sweep service's job (it
 * queries `Document`, not `Load.podStatus`); this function only consumes
 * that boolean.
 */

const MISSING_POD_SCOPE_STATUSES = ['DELIVERED', 'CLOSED'] as const;

/** BUSINESS POLICY (see this file's own doc comment) — not statistically derived. */
const MISSING_POD_THRESHOLD_HOURS = 48;

export type MissingPodClockBasis = 'closedAt' | 'deliveredAuditEntry';

export interface MissingPodInput {
  status: string;
  /** `Load.closedAt` — used only when `status === 'CLOSED'`. */
  closedAt: Date | null;
  /** The `'Load Status Advanced — Delivered'` AuditLog entry's `createdAt` (most recent), resolved by the sweep service — used only when `status === 'DELIVERED'`. There is no direct `Load` column for this. */
  deliveredAuditEntryAt: Date | null;
  /** True the instant any POD Document row exists for this Load's standard delivery stop(s), regardless of `scanStatus`. Resolved by the sweep service via a `Document` query, never derived from `Load.podStatus`. */
  hasAnyPodDocument: boolean;
  now?: Date;
}

export interface MissingPodResult {
  ageHours: number;
  clockBasis: MissingPodClockBasis;
  severity: AttentionSeverity;
}

/**
 * The full MISSING_POD qualification rule. Pure and side-effect-free — no
 * DB access. Never guesses a clock: if the status-appropriate timestamp
 * cannot be resolved, this returns `null` rather than falling back to any
 * other field (explicitly NOT `Load.updatedAt`, per the approved
 * contract).
 */
export function evaluateMissingPod(input: MissingPodInput): MissingPodResult | null {
  if (
    !MISSING_POD_SCOPE_STATUSES.includes(
      input.status as (typeof MISSING_POD_SCOPE_STATUSES)[number],
    )
  ) {
    return null;
  }

  // A POD document existing in ANY state (including the intentional,
  // expected SCAN_FAILED outcome from the Cloudmersive free-tier size
  // override) means this Load is NOT missing a POD. scanStatus is never
  // inspected beyond this point.
  if (input.hasAnyPodDocument) return null;

  let clockBasis: MissingPodClockBasis;
  let clockValue: Date | null;
  if (input.status === 'CLOSED') {
    clockBasis = 'closedAt';
    clockValue = input.closedAt;
  } else {
    clockBasis = 'deliveredAuditEntry';
    clockValue = input.deliveredAuditEntryAt;
  }
  if (!clockValue) return null; // never guess — no fallback to updatedAt or any other timestamp

  const now = input.now ?? new Date();
  const ageHours = (now.getTime() - clockValue.getTime()) / 3600000;
  if (ageHours < MISSING_POD_THRESHOLD_HOURS) return null;

  return { ageHours, clockBasis, severity: 'HIGH' };
}
