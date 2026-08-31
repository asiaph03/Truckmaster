import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TIMEZONE,
  formatBusinessDateTime,
  formatBusinessTime,
  getBusinessTimeZoneAbbreviation,
  toBusinessDatetimeLocalValue,
} from './businessTimezone';

describe('formatBusinessDateTime — displays a UTC instant explicitly in America/New_York', () => {
  it('formats a summer (EDT) instant as the correct Eastern wall-clock time', () => {
    // 18:30 UTC on 2026-07-15 is 14:30 (2:30 PM) EDT.
    expect(formatBusinessDateTime('2026-07-15T18:30:00.000Z')).toBe('Jul 15, 2:30 PM');
  });

  it('formats a winter (EST) instant as the correct Eastern wall-clock time', () => {
    // 19:30 UTC on 2026-01-15 is 14:30 (2:30 PM) EST.
    expect(formatBusinessDateTime('2026-01-15T19:30:00.000Z')).toBe('Jan 15, 2:30 PM');
  });

  it('is unaffected by the viewing browser being configured for a non-Eastern timezone', () => {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Singapore';
      expect(formatBusinessDateTime('2026-09-01T18:30:00.000Z')).toBe('Sep 1, 2:30 PM');
      process.env.TZ = 'Pacific/Auckland';
      expect(formatBusinessDateTime('2026-09-01T18:30:00.000Z')).toBe('Sep 1, 2:30 PM');
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it('returns an em-dash placeholder for a null/undefined value', () => {
    expect(formatBusinessDateTime(null)).toBe('—');
    expect(formatBusinessDateTime(undefined)).toBe('—');
  });
});

describe('formatBusinessTime — time-of-day only, explicitly Eastern', () => {
  it('formats the Eastern time-of-day for a UTC instant', () => {
    expect(formatBusinessTime('2026-07-15T18:30:00.000Z')).toBe('2:30 PM');
  });
});

describe('toBusinessDatetimeLocalValue — UTC instant -> Eastern datetime-local wall-clock value', () => {
  it('converts a UTC instant to the Eastern wall-clock value a datetime-local input expects', () => {
    expect(toBusinessDatetimeLocalValue('2026-07-15T18:30:00.000Z')).toBe('2026-07-15T14:30');
  });

  it('is unaffected by the viewing browser being configured for a non-Eastern timezone', () => {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Singapore';
      const singapore = toBusinessDatetimeLocalValue('2026-07-15T18:30:00.000Z');
      process.env.TZ = 'Pacific/Auckland';
      const auckland = toBusinessDatetimeLocalValue('2026-07-15T18:30:00.000Z');

      expect(singapore).toBe('2026-07-15T14:30');
      expect(auckland).toBe('2026-07-15T14:30');
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it('round-trips through the winter (EST) offset correctly', () => {
    expect(toBusinessDatetimeLocalValue('2026-01-15T19:30:00.000Z')).toBe('2026-01-15T14:30');
  });
});

describe('Edit -> save -> reload regression: the Eastern wall-clock value survives a full round trip', () => {
  it('a value typed as Eastern wall-clock, once stored as UTC, formats back to the exact same Eastern wall-clock value', () => {
    const enteredEasternWallClock = '2026-09-01T14:30';
    // What the backend's parseBusinessWallClock would store for this
    // input (mirrors the backend test of the identical scenario).
    const storedUtcInstant = '2026-09-01T18:30:00.000Z';

    expect(toBusinessDatetimeLocalValue(storedUtcInstant)).toBe(enteredEasternWallClock);
  });
});

describe('getBusinessTimeZoneAbbreviation — header clock EST/EDT indicator, IANA-driven', () => {
  it('returns EDT for a summer instant', () => {
    expect(getBusinessTimeZoneAbbreviation(new Date('2026-07-15T18:30:00.000Z'))).toBe('EDT');
  });

  it('returns EST for a winter instant', () => {
    expect(getBusinessTimeZoneAbbreviation(new Date('2026-01-15T18:30:00.000Z'))).toBe('EST');
  });

  it('flips automatically across the DST transition, without any hardcoded offset', () => {
    // Just before the 2026 spring-forward (2026-03-08, 2:00 AM local).
    expect(getBusinessTimeZoneAbbreviation(new Date('2026-03-08T06:30:00.000Z'))).toBe('EST');
    // Just after.
    expect(getBusinessTimeZoneAbbreviation(new Date('2026-03-08T07:30:00.000Z'))).toBe('EDT');
  });

  it('defaults to the current instant when called with no argument', () => {
    expect(getBusinessTimeZoneAbbreviation()).toMatch(/^E[SD]T$/);
  });

  it('is unaffected by the viewing browser being configured for a non-Eastern timezone', () => {
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Singapore';
      const summerSingapore = getBusinessTimeZoneAbbreviation(new Date('2026-07-15T18:30:00.000Z'));
      process.env.TZ = 'Pacific/Auckland';
      const summerAuckland = getBusinessTimeZoneAbbreviation(new Date('2026-07-15T18:30:00.000Z'));

      expect(summerSingapore).toBe('EDT');
      expect(summerAuckland).toBe('EDT');
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});

describe('BUSINESS_TIMEZONE', () => {
  it('is the IANA identifier America/New_York, not a fixed offset', () => {
    expect(BUSINESS_TIMEZONE).toBe('America/New_York');
  });
});
