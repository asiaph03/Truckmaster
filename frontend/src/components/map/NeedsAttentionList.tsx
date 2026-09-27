import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportingApi, type NeedsAttentionItem } from '../../api';
import { Badge, Button, EmptyState, QueryErrorState, getStatusBadgeColor } from '../ui';
import { formatRelativeTime } from '../../lib/formatRelativeTime';
import './NeedsAttentionList.css';

const PAGE_SIZE = 25;

/**
 * B.5 — Dashboard "Needs Attention Today". Combines two sources the
 * backend already normalized into one shape (`ReportingService.needsAttention`):
 * legacy Notification signals (Check Call overdue/due-soon, Load late)
 * and active `AttentionItem` rows from Needs Attention V2's detectors
 * (currently STALE_LOCATION; every future detector fits this same list
 * automatically, since nothing here is specific to any one type).
 * Deliberately no per-item acknowledge/dismiss control — an AttentionItem
 * resolves itself when its underlying condition clears (sweep-driven),
 * and a Notification's own read-state is managed elsewhere (NotificationBell).
 */
export function NeedsAttentionList() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard', 'needs-attention', page],
    queryFn: () => reportingApi.needsAttention({ page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
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
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="needs-attention">
      <h2 className="needs-attention-title">Needs Attention Today</h2>
      {items.length === 0 ? (
        <EmptyState message="Nothing needs attention right now." />
      ) : (
        <>
          <ul className="needs-attention-list">
            {items.map((item) => (
              <NeedsAttentionRow key={item.id} item={item} />
            ))}
          </ul>
          {totalPages > 1 ? (
            <div className="needs-attention-pagination">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => p - 1)}
                disabled={page <= 1}
              >
                Prev
              </Button>
              <span className="needs-attention-pagination-page">
                {page} / {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function NeedsAttentionRow({ item }: { item: NeedsAttentionItem }) {
  const headline = item.title ?? item.message ?? '';
  const timestamp = item.detectedAt ?? item.createdAt;

  return (
    <li className="needs-attention-item">
      <div className="needs-attention-item-header">
        <Badge
          label={item.severity}
          color={getStatusBadgeColor('AttentionItem.severity', item.severity) ?? 'neutral'}
        />
        <a className="needs-attention-item-load" href={`/loads/${item.loadId}`}>
          {item.loadNumber}
        </a>
      </div>
      <span className="needs-attention-headline">{headline}</span>
      {item.reason ? <span className="needs-attention-reason">{item.reason}</span> : null}
      {item.impact ? <span className="needs-attention-impact">{item.impact}</span> : null}
      {timestamp ? (
        <span className="needs-attention-time">{formatRelativeTime(timestamp)}</span>
      ) : null}
    </li>
  );
}
