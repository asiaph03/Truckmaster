import {
  BUSINESS_TIMEZONE,
  parseBusinessDateTime,
  parseBusinessWallClock,
} from './business-timezone';

describe('parseBusinessWallClock — America/New_York wall-clock -> UTC instant', () => {
  it('interprets a summer (EDT, UTC-4) wall-clock time correctly', () => {
    // July is unambiguously EDT.
    const result = parseBusinessWallClock('2026-07-15T14:30');
    expect(result.toISOString()).toBe('2026-07-15T18:30:00.000Z');
  });

  it('interprets a winter (EST, UTC-5) wall-clock time correctly', () => {
    // January is unambiguously EST.
    const result = parseBusinessWallClock('2026-01-15T14:30');
    expect(result.toISOString()).toBe('2026-01-15T19:30:00.000Z');
  });

  it('the exact scenario from the investigation: 2026-09-01T14:30 (2:30 PM Eastern, EDT) -> correct UTC instant', () => {
    const result = parseBusinessWallClock('2026-09-01T14:30');
    expect(result.toISOString()).toBe('2026-09-01T18:30:00.000Z');
  });

  describe('DST spring-forward transition (2026-03-08, America/New_York: 01:59:59 EST -> 03:00:00 EDT)', () => {
    it('resolves an unambiguous time just before the transition (still EST)', () => {
      const result = parseBusinessWallClock('2026-03-08T01:30');
      expect(result.toISOString()).toBe('2026-03-08T06:30:00.000Z'); // 1:30 AM EST = 06:30 UTC
    });

    it('resolves an unambiguous time just after the transition (already EDT)', () => {
      const result = parseBusinessWallClock('2026-03-08T03:30');
      expect(result.toISOString()).toBe('2026-03-08T07:30:00.000Z'); // 3:30 AM EDT = 07:30 UTC
    });

    it('throws a clear, documented error for a wall-clock time that does not exist (the skipped hour)', () => {
      // 2:00-2:59 AM never happens in America/New_York on this date —
      // clocks jump straight from 1:59:59 EST to 3:00:00 EDT.
      expect(() => parseBusinessWallClock('2026-03-08T02:30')).toThrow(
        /does not exist in America\/New_York.*spring-forward/,
      );
    });
  });

  describe('DST fall-back transition (2026-11-01, America/New_York: 01:59:59 EDT -> 01:00:00 EST, the 1 AM hour repeats)', () => {
    it('deterministically resolves the repeated hour to its earlier (still-EDT) occurrence, documented behavior', () => {
      // 1:30 AM happens twice: once as EDT (05:30 UTC), once as EST
      // (06:30 UTC). We document and test that we always pick the
      // earlier UTC instant.
      const result = parseBusinessWallClock('2026-11-01T01:30');
      expect(result.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    });

    it('resolves an unambiguous time well before the repeated hour (still EDT)', () => {
      const result = parseBusinessWallClock('2026-11-01T00:30');
      expect(result.toISOString()).toBe('2026-11-01T04:30:00.000Z'); // 00:30 EDT = 04:30 UTC
    });

    it('resolves an unambiguous time well after the repeated hour (already EST)', () => {
      const result = parseBusinessWallClock('2026-11-01T03:30');
      expect(result.toISOString()).toBe('2026-11-01T08:30:00.000Z'); // 3:30 AM EST = 08:30 UTC
    });
  });

  it('accepts seconds in the wall-clock string', () => {
    const result = parseBusinessWallClock('2026-07-15T14:30:45');
    expect(result.toISOString()).toBe('2026-07-15T18:30:45.000Z');
  });

  it('rejects a malformed wall-clock string', () => {
    expect(() => parseBusinessWallClock('not-a-date')).toThrow();
  });

  it('is independent of the server process timezone (requirement: never rely on server-local time)', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Singapore';
      const resultSingapore = parseBusinessWallClock('2026-09-01T14:30').toISOString();

      process.env.TZ = 'UTC';
      const resultUtc = parseBusinessWallClock('2026-09-01T14:30').toISOString();

      process.env.TZ = 'America/Los_Angeles';
      const resultPacific = parseBusinessWallClock('2026-09-01T14:30').toISOString();

      expect(resultSingapore).toBe('2026-09-01T18:30:00.000Z');
      expect(resultUtc).toBe('2026-09-01T18:30:00.000Z');
      expect(resultPacific).toBe('2026-09-01T18:30:00.000Z');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('parseBusinessDateTime — the write-path entry point (safe for either naive or already-explicit input)', () => {
  it('interprets a naive (no offset) string as America/New_York wall-clock', () => {
    expect(parseBusinessDateTime('2026-09-01T14:30').toISOString()).toBe(
      '2026-09-01T18:30:00.000Z',
    );
  });

  it('respects a string that already carries a Z suffix, without re-interpreting it', () => {
    // Critical case: some existing callers (e.g. CalendarBoard's
    // day-only drag-to-reschedule) already send a fully-resolved UTC
    // ISO string. That must be passed through untouched, never treated
    // as if its digits were naive Eastern wall-clock digits.
    expect(parseBusinessDateTime('2026-09-01T18:30:00.000Z').toISOString()).toBe(
      '2026-09-01T18:30:00.000Z',
    );
  });

  it('respects a string that already carries an explicit numeric offset', () => {
    expect(parseBusinessDateTime('2026-09-01T14:30:00-04:00').toISOString()).toBe(
      '2026-09-01T18:30:00.000Z',
    );
  });
});

describe('BUSINESS_TIMEZONE', () => {
  it('is the IANA identifier America/New_York, not a fixed offset', () => {
    expect(BUSINESS_TIMEZONE).toBe('America/New_York');
  });
});
