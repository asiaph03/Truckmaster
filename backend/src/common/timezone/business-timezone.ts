/**
 * Frontend Phase 23 timezone fix — the single, centralized place that
 * understands what "the business timezone" means, so it never has to be
 * re-derived (or accidentally left to the server's own OS timezone) at
 * each of the several places that write a user-entered appointment/
 * check-call/communication timestamp.
 *
 * Operational timestamps in this app (Stop.appointmentDatetime,
 * CheckCall.occurredAt/eta, Load.currentEta, CommunicationActivity.
 * occurredAt) represent a specific real-world instant that a human
 * intended in Eastern Time — never a fixed EST (UTC-5) offset, since
 * that silently breaks for half the year. `America/New_York` is an IANA
 * timezone identifier, so Node's built-in `Intl`/ICU support resolves the
 * correct EST/EDT offset for any given date automatically, with no
 * external dependency.
 */
export const BUSINESS_TIMEZONE = 'America/New_York';

interface WallClockParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const NAIVE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** True for a string that already carries explicit timezone info (`Z` or a `+HH:MM`/`-HH:MM` offset). */
function hasExplicitOffset(input: string): boolean {
  return /Z$|[+-]\d{2}:?\d{2}$/.test(input.trim());
}

function parseNaiveComponents(input: string): WallClockParts {
  const match = NAIVE_DATETIME_PATTERN.exec(input.trim());
  if (!match) {
    throw new Error(
      `Cannot interpret "${input}" as a wall-clock datetime (expected e.g. "2026-09-01T14:30").`,
    );
  }
  const [, y, mo, d, h, mi, s] = match;
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s ? Number(s) : 0,
  };
}

/** Formats a UTC instant as its wall-clock digits in `timeZone`, via `Intl` (no fixed-offset math). */
function wallClockPartsInZone(instant: Date, timeZone: string): WallClockParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const byType: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') byType[part.type] = part.value;
  }
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour === '24' ? '00' : byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function toUtcMs(parts: WallClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function partsEqual(a: WallClockParts, b: WallClockParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The offset (in minutes, e.g. -240 for EDT, -300 for EST) that
 * `timeZone` has at the given UTC instant — read live from ICU's tzdata,
 * never hardcoded, so it's automatically correct on either side of a DST
 * transition and stays correct if the transition dates ever change.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const asUtcMs = toUtcMs(wallClockPartsInZone(instant, timeZone));
  return (asUtcMs - instant.getTime()) / 60000;
}

/**
 * Interprets a naive ("YYYY-MM-DDTHH:mm[:ss]", no timezone marker)
 * wall-clock string as a moment in `timeZone` and returns the
 * corresponding absolute UTC instant.
 *
 * DST handling, explicit: `America/New_York` changes its UTC offset at
 * most once per calendar day, so probing the offset at the start and end
 * of the target calendar day is guaranteed to surface every offset that
 * could apply — without hardcoding *when* transitions happen (that's
 * left entirely to ICU/tzdata). For each candidate offset, we compute
 * the resulting UTC instant and check whether formatting it back into
 * `timeZone` reproduces the original wall-clock digits:
 *
 * - Exactly one candidate round-trips → the normal, unambiguous case.
 * - Zero candidates round-trip → the wall-clock time was skipped by a
 *   spring-forward transition (e.g. 2:30 AM on the "spring forward" day
 *   in America/New_York never happens — clocks jump 1:59:59 -> 3:00:00).
 *   This throws rather than silently guessing, since there is no
 *   correct answer to return.
 * - Two candidates round-trip → the wall-clock hour was repeated by a
 *   fall-back transition (e.g. 1:30 AM in America/New_York occurs twice
 *   — once at EDT, once at EST). This is genuinely ambiguous; we
 *   deliberately and documentedly resolve to the *earlier* UTC instant
 *   (the still-daylight-saving/EDT occurrence), the same convention
 *   `date-fns-tz`/`moment-timezone` use by default.
 */
export function parseBusinessWallClock(
  naiveDateTime: string,
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  const target = parseNaiveComponents(naiveDateTime);
  const naiveAsUtcMs = toUtcMs(target);

  const dayStartProbe = new Date(Date.UTC(target.year, target.month - 1, target.day, 0, 0, 0));
  const dayEndProbe = new Date(Date.UTC(target.year, target.month - 1, target.day, 23, 59, 59));
  const candidateOffsets = Array.from(
    new Set([offsetMinutesAt(dayStartProbe, timeZone), offsetMinutesAt(dayEndProbe, timeZone)]),
  );

  const matches: number[] = [];
  for (const offsetMinutes of candidateOffsets) {
    const candidateMs = naiveAsUtcMs - offsetMinutes * 60000;
    const roundTrip = wallClockPartsInZone(new Date(candidateMs), timeZone);
    if (partsEqual(roundTrip, target)) matches.push(candidateMs);
  }

  if (matches.length === 0) {
    throw new Error(
      `"${naiveDateTime}" does not exist in ${timeZone} — it falls in a spring-forward ` +
        'DST gap (clocks skip this wall-clock hour on this date).',
    );
  }

  // Ambiguous (fall-back repeated hour): documented choice — earlier
  // instant wins, i.e. the daylight-saving (EDT) occurrence.
  return new Date(Math.min(...matches));
}

/**
 * Parses a datetime string that may or may not already carry explicit
 * timezone info. A string with a `Z`/offset suffix is already
 * unambiguous and is respected as-is (never re-interpreted). A naive
 * string (no offset — what a `datetime-local` input produces) is
 * explicitly interpreted as `America/New_York` wall-clock time via
 * {@link parseBusinessWallClock}. This is the function write paths
 * should call — it's safe regardless of which shape of string a given
 * caller happens to send.
 */
export function parseBusinessDateTime(
  dateTimeInput: string,
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  if (hasExplicitOffset(dateTimeInput)) {
    return new Date(dateTimeInput);
  }
  return parseBusinessWallClock(dateTimeInput, timeZone);
}
