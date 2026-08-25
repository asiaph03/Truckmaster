import { EmptyState } from '../components/ui';

/**
 * Placeholder for nav destinations with no locked screen-level design yet
 * (Document Center, Reports) — of the remaining undesigned items (Document
 * Center, Reports Library, Organization Settings), none has an approved
 * scope to build against (Dashboard, membership role-editing, and Load
 * Search were the exceptions, built in Frontend Phases 10, 11, and 13
 * respectively). This placeholder exists only so the always-visible shell
 * nav doesn't link to a blank/broken route.
 */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-h1-size)', marginBottom: 'var(--space-4)' }}>{title}</h1>
      <EmptyState message="This screen is coming in a later phase." />
    </div>
  );
}
