export const SCHEDULED_JOBS_QUEUE = 'SCHEDULED_JOBS_QUEUE';
export const SCHEDULED_JOBS_QUEUE_NAME = 'scheduled-jobs';

/**
 * One shared queue for every Phase 7 sweep (Decision 7 — reuse BullMQ's
 * own repeatable-job capability, no new scheduler dependency). A single
 * queue/worker pair, distinguished by job name, rather than one queue per
 * sweep (the existing one-queue-per-concern precedent from Phases 2/4/6
 * was for distinct one-shot, user-action-triggered jobs — these five are
 * one cohesive "daily background maintenance" concern, so sharing a queue
 * is the better-fit abstraction, not a deviation from the pattern).
 */
export const JOB_NAMES = {
  INVITATION_EXPIRATION_SWEEP: 'invitation-expiration-sweep',
  QUOTE_EXPIRATION_SWEEP: 'quote-expiration-sweep',
  CARRIER_COMPLIANCE_EXPIRATION_SWEEP: 'carrier-compliance-expiration-sweep',
  COMPLIANCE_EXPIRATION_NOTIFICATIONS: 'compliance-expiration-notifications',
  CHECK_CALL_REMINDER_SWEEP: 'check-call-reminder-sweep',
  LOAD_LATENESS_SWEEP: 'load-lateness-sweep',
} as const;

/** Decision 8 — 03:00 UTC, a fixed documented constant (no per-org timezone concept exists in V1). */
export const DAILY_SWEEP_CRON = '0 3 * * *';

/**
 * Operational Alerts feature — shared cadence for CHECK_CALL_REMINDER_SWEEP
 * (which now also detects CHECK_CALL_DUE_SOON) and LOAD_LATENESS_SWEEP.
 * Deliberately decoupled from `CHECK_CALL_REMINDER_HOURS` (the OVERDUE
 * threshold, unchanged at 4h) — the sweep must run more often than the
 * threshold itself so a 15-minute due-soon lead time is never missed
 * between runs, without going as aggressive as every 5 minutes (explicitly
 * rejected — would multiply the per-org load-scan query volume for
 * marginal benefit over a 15-minute cadence, which already guarantees the
 * 15-minute due-soon window is caught by at least one sweep pass).
 */
export const OPERATIONAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
