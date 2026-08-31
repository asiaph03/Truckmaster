import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EasternClock } from './EasternClock';

describe('EasternClock — header live Eastern Time clock', () => {
  const originalTZ = process.env.TZ;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = originalTZ;
  });

  it('displays the current Eastern time, date, and EDT indicator for a summer instant — never the server/browser local timezone', () => {
    process.env.TZ = 'Asia/Singapore';
    // 18:30 UTC on 2026-07-15 is 2:30 PM EDT, not the Singapore-local
    // equivalent (02:30 the next day).
    vi.setSystemTime(new Date('2026-07-15T18:30:00.000Z'));

    render(<EasternClock />);

    expect(screen.getByText('2:30 PM')).toBeInTheDocument();
    expect(screen.getByText('Jul 15, 2026')).toBeInTheDocument();
    expect(screen.getByText('EDT')).toBeInTheDocument();
  });

  it('displays EST for a winter instant', () => {
    process.env.TZ = 'UTC';
    // 19:30 UTC on 2026-01-15 is 2:30 PM EST.
    vi.setSystemTime(new Date('2026-01-15T19:30:00.000Z'));

    render(<EasternClock />);

    expect(screen.getByText('2:30 PM')).toBeInTheDocument();
    expect(screen.getByText('EST')).toBeInTheDocument();
  });

  it('updates automatically, without a remount or page refresh, as time passes', () => {
    vi.setSystemTime(new Date('2026-07-15T18:30:00.000Z'));
    render(<EasternClock />);
    expect(screen.getByText('2:30 PM')).toBeInTheDocument();

    // Advance the clock to a new minute, then let the component's own
    // 1s interval fire once — it should pick this up and re-render with
    // no remount.
    act(() => {
      vi.setSystemTime(new Date('2026-07-15T18:35:30.000Z'));
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText('2:35 PM')).toBeInTheDocument();
    expect(screen.queryByText('2:30 PM')).not.toBeInTheDocument();
  });

  it('flips from EDT to EST live if the clock ticks across the DST boundary, with no hardcoded offset', () => {
    // A moment just before the 2026 fall-back transition (2026-11-01, 2:00 AM EDT local = 06:00 UTC).
    vi.setSystemTime(new Date('2026-11-01T05:59:30.000Z'));
    render(<EasternClock />);
    expect(screen.getByText('EDT')).toBeInTheDocument();

    act(() => {
      vi.setSystemTime(new Date('2026-11-01T06:00:30.000Z'));
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText('EST')).toBeInTheDocument();
  });
});
