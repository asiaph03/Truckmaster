import { EmptyState } from '../components/ui';

/**
 * Placeholder for nav destinations with no locked screen-level design yet
 * (currently just the Reports library) — it has no approved scope to
 * build against. Document Center used this placeholder too until Frontend
 * Phase 20 built it against an approved design. This placeholder exists
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
