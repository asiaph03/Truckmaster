import { useQuery } from '@tanstack/react-query';
import { reportingApi } from '../../api';
import { EmptyState, QueryErrorState } from '../ui';
import './NeedsAttentionList.css';

/**
 * Dashboard "Needs Attention Today" — a minimal first version: real,
 * already-computed `Notification` rows (Check Call overdue/due-soon,
 * Load late), each linking straight to its Load. Deliberately not the
 * full-featured version (no per-item dismissal, no additional
 * "missing documents"/"requires dispatcher action" categories) —
 * those remain a separate, not-yet-approved phase; this is the map
 * implementation's minimal companion panel for the two-panel Dashboard
 * layout that was approved alongside it.
 */
export function NeedsAttentionList() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard', 'needs-attention'],
    queryFn: () => reportingApi.needsAttention(),
  });

  if (isLoading) {
    return <div className="needs-attention-loading">Loading…</div>;
  }

  if (isError) {
    return (
      <QueryErrorState
        message="Couldn't load Needs Attention Today. Please try again."
        onRetry={() => refetch()}
      />
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="needs-attention">
      <h2 className="needs-attention-title">Needs Attention Today</h2>
      {items.length === 0 ? (
        <EmptyState message="Nothing needs attention right now." />
      ) : (
        <ul className="needs-attention-list">
          {items.map((item) => (
            <li key={item.id}>
              <a href={`/loads/${item.loadId}`}>{item.loadNumber}</a>
              <span className="needs-attention-message">{item.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
