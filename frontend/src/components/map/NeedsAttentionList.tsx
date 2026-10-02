import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportingApi, type NeedsAttentionItem } from '../../api';
import { Badge, Button, EmptyState, QueryErrorState, getStatusBadgeColor } from '../ui';
import { formatRelativeTime } from '../../lib/formatRelativeTime';
import './NeedsAttentionList.css';

const PAGE_SIZE = 25;

/**
 * Attention System Quality Review (post-B.8 audit) — the raw `type` enum
 * (e.g. `APPOINTMENT_IMMINENT_NO_CHECK_CALL`) was never shown to the user;
 * this is the only place that translates it to a human label. An unknown/
 * future type (a detector added after this map was written) falls back to
 * the raw string rather than crashing or hiding the item.
 */
const ATTENTION_TYPE_LABELS: Record<string, string> = {
  ETA_AFTER_APPOINTMENT: 'ETA After Appointment',
  STALE_LOCATION: 'Stale Location',
  APPOINTMENT_IMMINENT_NO_CHECK_CALL: 'Appointment Imminent — No Check Call',
  MISSING_POD: 'Missing POD',
  CHECK_CALL_OVERDUE: 'Check Call Overdue',
  LOAD_LATE: 'Load Late',
  CHECK_CALL_DUE_SOON: 'Check Call Due Soon',
};

function typeLabel(type: string): string {
  return ATTENTION_TYPE_LABELS[type] ?? type;
}

/** Distinguishes a sweep-driven AttentionItem from a legacy read/unread Notification — same `source` field the API already returns (B.5). */
function sourceLabel(source: NeedsAttentionItem['source']): string {
  return source === 'ATTENTION_ITEM' ? 'Attention' : 'Notification';
}

function sourceBadgeColor(source: NeedsAttentionItem['source']): 'brand' | 'neutral' {
  return source === 'ATTENTION_ITEM' ? 'brand' : 'neutral';
}

interface SuggestedAction {
  type: string;
  [key: string]: unknown;
}

/**
 * `suggestedActions` is `unknown` on the wire (Prisma `Json`) — this is the
 * one place that parses it. Anything that isn't a well-formed array of
 * `{ type: string, ... }` objects (including `null`, which every
 * Notification-sourced item has) becomes an empty list rather than
 * throwing. An action `type` this UI doesn't recognize (a future backend
 * addition) is silently skipped in the renderer below, never dumped as
 * raw JSON and never invented a label for.
 */
function parseSuggestedActions(value: unknown): SuggestedAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (action): action is SuggestedAction =>
      typeof action === 'object' &&
      action !== null &&
      typeof (action as { type?: unknown }).type === 'string',
  );
}

/**
 * B.8 audit follow-up — MISSING_POD's `severity` is HIGH for every item
 * from 48 hours to 29+ days overdue (by contract — see missing-pod-risk.ts),
 * so the badge alone can't distinguish a 2-day item from a month-old one.
 * This reads the sweep's own `metadata.ageHours` (already on the wire) to
 * render a secondary, non-severity magnitude cue. Severity itself is
 * never touched. Returns `null` whenever `ageHours` isn't a number (any
 * other type, or a MISSING_POD row that predates this metadata field).
 */
function missingPodAgeLabel(item: NeedsAttentionItem): string | null {
  if (item.type !== 'MISSING_POD') return null;
  if (!item.metadata || typeof item.metadata !== 'object') return null;
  const ageHours = (item.metadata as Record<string, unknown>).ageHours;
  if (typeof ageHours !== 'number') return null;
  const days = (ageHours / 24).toFixed(1);
  return `${days} days overdue`;
}

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
  const ageLabel = missingPodAgeLabel(item);
  const actions = parseSuggestedActions(item.suggestedActions);

  return (
    <li className="needs-attention-item">
      <div className="needs-attention-item-header">
        <Badge
          label={item.severity}
          color={getStatusBadgeColor('AttentionItem.severity', item.severity) ?? 'neutral'}
        />
        <Badge label={sourceLabel(item.source)} color={sourceBadgeColor(item.source)} />
        <a className="needs-attention-item-load" href={`/loads/${item.loadId}`}>
          {item.loadNumber}
        </a>
      </div>
      <span className="needs-attention-item-type">{typeLabel(item.type)}</span>
      <span className="needs-attention-headline">{headline}</span>
      {item.reason ? <span className="needs-attention-reason">{item.reason}</span> : null}
      {item.impact ? <span className="needs-attention-impact">{item.impact}</span> : null}
      {ageLabel ? <span className="needs-attention-age">{ageLabel}</span> : null}
      {actions.length > 0 ? (
        <div className="needs-attention-item-actions">
          {actions.map((action, index) =>
            action.type === 'VIEW_LOAD' ? (
              <a
                key={index}
                className="needs-attention-item-action"
                href={`/loads/${item.loadId}`}
                aria-label={`View Load ${item.loadNumber}`}
              >
                View Load
              </a>
            ) : null,
          )}
        </div>
      ) : null}
      {timestamp ? (
        <span className="needs-attention-time">{formatRelativeTime(timestamp)}</span>
      ) : null}
    </li>
  );
}
