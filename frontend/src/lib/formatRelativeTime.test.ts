import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './formatRelativeTime';

const NOW = new Date('2026-09-26T12:00:00Z');

describe('formatRelativeTime — Dashboard Map Phase', () => {
  it('renders under a minute as "Just now"', () => {
    expect(formatRelativeTime('2026-09-26T11:59:40Z', NOW)).toBe('Just now');
  });

  it('renders minutes', () => {
    expect(formatRelativeTime('2026-09-26T11:45:00Z', NOW)).toBe('15 minutes ago');
  });

  it('renders hours — the brief’s own example', () => {
    expect(formatRelativeTime('2026-09-26T10:00:00Z', NOW)).toBe('2 hours ago');
  });

  it('renders days — obviously stale, not hidden', () => {
    expect(formatRelativeTime('2026-09-23T12:00:00Z', NOW)).toBe('3 days ago');
  });

  it('renders months for anything older than 30 days', () => {
    expect(formatRelativeTime('2026-06-26T12:00:00Z', NOW)).toBe('3 months ago');
  });
});
