import { evaluateLocationStaleness, computeStaleLocationSeverity } from './location-staleness';

const NOW = new Date('2026-09-05T20:00:00.000Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60000);
}

describe('evaluateLocationStaleness — STALE_LOCATION detector logic', () => {
  it('returns null when currentLocationUpdatedAt is null — a freshly-dispatched Load is not "stale"', () => {
    const result = evaluateLocationStaleness({ currentLocationUpdatedAt: null, now: NOW });
    expect(result).toBeNull();
  });

  it('returns null at 119 minutes (just under the threshold)', () => {
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(119),
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('MEDIUM at exactly 120 minutes', () => {
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(120),
      now: NOW,
    });
    expect(result).toEqual({ ageMinutes: 120, severity: 'MEDIUM' });
  });

  it('MEDIUM at 179 minutes (just under the HIGH threshold)', () => {
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(179),
      now: NOW,
    });
    expect(result).toEqual({ ageMinutes: 179, severity: 'MEDIUM' });
  });

  it('HIGH at exactly 180 minutes', () => {
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(180),
      now: NOW,
    });
    expect(result).toEqual({ ageMinutes: 180, severity: 'HIGH' });
  });

  it('a large stale age (e.g. 36 hours) is still HIGH, never CRITICAL — no third tier exists', () => {
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(36 * 60),
      now: NOW,
    });
    expect(result).toEqual({ ageMinutes: 36 * 60, severity: 'HIGH' });
  });

  it('never reads coordinates or resolution status — a fresh timestamp with no other location data is simply not stale (nothing to inspect in the first place)', () => {
    // This function's input type doesn't even accept lat/lng/resolutionStatus
    // fields — this test documents that omission is intentional, not an
    // oversight: freshness is the only question asked.
    const result = evaluateLocationStaleness({
      currentLocationUpdatedAt: minutesAgo(10),
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it('defaults `now` to the real current time when omitted', () => {
    const result = evaluateLocationStaleness({ currentLocationUpdatedAt: new Date() });
    expect(result).toBeNull(); // "just now" is never stale
  });
});

describe('computeStaleLocationSeverity', () => {
  it.each([
    [120, 'MEDIUM'],
    [150, 'MEDIUM'],
    [179, 'MEDIUM'],
    [180, 'HIGH'],
    [1000, 'HIGH'],
  ])('%i minutes → %s', (minutes, severity) => {
    expect(computeStaleLocationSeverity(minutes)).toBe(severity);
  });
});
