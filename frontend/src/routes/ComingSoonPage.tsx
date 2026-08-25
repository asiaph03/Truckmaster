import { EmptyState } from '../components/ui';

/**
 * Placeholder for nav destinations with no locked screen-level design yet
 * (Dashboard, Document Center, Reports) — as of the Frontend Phase 8
 * inspection, none of the remaining undesigned items (Dashboard, Document
 * Center, Reports Library, Load Search, Organization Settings, membership
 * role-editing) has an approved scope to build against. This placeholder
 * exists only so the always-visible shell nav doesn't link to a blank/
 * broken route.
 */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-h1-size)', marginBottom: 'var(--space-4)' }}>{title}</h1>
      <EmptyState message="This screen is coming in a later phase." />
    </div>
  );
}
