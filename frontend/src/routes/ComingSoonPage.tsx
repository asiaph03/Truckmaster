import { EmptyState } from '../components/ui';

/**
 * Nav destinations not yet built (Loads, Billing, Documents Center,
 * Reports, Settings, Dashboard) — kept out of Phase 2 scope per the
 * approved plan. This placeholder exists only so the always-visible
 * shell nav doesn't link to a blank/broken route.
 */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 'var(--text-h1-size)', marginBottom: 'var(--space-4)' }}>{title}</h1>
      <EmptyState message="This screen is coming in a later phase." />
    </div>
  );
}
