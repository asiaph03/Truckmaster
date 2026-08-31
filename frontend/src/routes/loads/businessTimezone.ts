/**
 * Frontend Phase 23 timezone fix — the single, centralized place that
 * knows the app's business/display timezone for operational stop and
 * activity timestamps (appointmentDatetime, actualArrival,
 * actualDeparture, CheckCall.occurredAt, CommunicationActivity.
 * occurredAt). Mirrors backend/src/common/timezone/business-timezone.ts:
 * the backend owns turning a wall-clock string INTO the correct UTC
 * instant on write; this module owns turning a stored UTC instant back
 * INTO Eastern wall-clock for display/edit, explicitly — never the
 * viewing browser's own local timezone.
 */
export const BUSINESS_TIMEZONE = 'America/New_York';

interface WallClockParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function wallClockPartsInBusinessTimezone(instant: Date): WallClockParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const byType: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') byType[part.type] = part.value;
  }
  return {
    year: byType.year,
    month: byType.month,
    day: byType.day,
    hour: byType.hour === '24' ? '00' : byType.hour,
    minute: byType.minute,
  };
}

/**
 * Formats a stored UTC instant (ISO string) explicitly in
 * `America/New_York`, regardless of the viewing browser's own
 * timezone — replaces ad hoc `toLocaleString(undefined, ...)` calls for
 * the operational timestamp fields listed above.
 */
export function formatBusinessDateTime(
  iso: string | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { ...options, timeZone: BUSINESS_TIMEZONE });
}

/** Time-of-day only, e.g. for the Calendar's compact event chips. */
export function formatBusinessTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: BUSINESS_TIMEZONE,
  });
}

/**
 * Converts a stored UTC instant into the Eastern wall-clock value a
 * `datetime-local` input expects ("YYYY-MM-DDTHH:mm"). Used to prefill
 * an edit form so the field shows the same Eastern time a human
 * originally intended — never the value re-expressed in the browser's
 * own local timezone. With no `iso`, prefills "now" in Eastern.
 */
export function toBusinessDatetimeLocalValue(iso?: string): string {
  const instant = iso ? new Date(iso) : new Date();
  const { year, month, day, hour, minute } = wallClockPartsInBusinessTimezone(instant);
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
