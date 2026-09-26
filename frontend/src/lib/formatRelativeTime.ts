/**
 * Dashboard Map Phase — "Updated 2 hours ago" / "Updated 3 days ago".
 * Deliberately never hides staleness: there is no rounding trick or
 * "just now" grace period beyond one minute, since the whole point of
 * showing this text next to a "Last Known Location" is to make an old,
 * manually-logged position look exactly as old as it is — never like a
 * live GPS fix.
 */
export function formatRelativeTime(isoOrDate: string | Date, now: Date = new Date()): string {
  const then = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  const diffMs = now.getTime() - then.getTime();
  const diffMinutes = Math.round(diffMs / 60000);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
}
