import { EmptyState } from '../components/ui';

/**
 * Placeholder for nav destinations with no locked screen-level design yet
 * (Document Center, Reports) — of the remaining undesigned items (Document
 * Center, Reports Library, Load Search, Organization Settings, membership
 * role-editing), none has an approved scope to build against (Dashboard
 * was the exception, built in Frontend Phase 10). This placeholder exists
 * only so the always-visible shell nav doesn't link to a blank/broken
 * route.
 */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-h1-size)', marginBottom: 'var(--space-4)' }}>{title}</h1>
      <EmptyState message="This screen is coming in a later phase." />
    </div>
  );
}
