import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, MessageSquare, StickyNote } from 'lucide-react';
import { activityApi, membershipsApi, type ActivityTimelineEntry, type Load } from '../../../api';
import { Button, FilterChip } from '../../../components/ui';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatDateShort } from '../loadDerived';
import { AddInternalNoteModal } from '../modals/AddInternalNoteModal';
import { LogCommunicationActivityModal } from '../modals/LogCommunicationActivityModal';
import '../../shared/DetailPage.css';
import './ActivityHistoryTab.css';

type FilterKey = 'ALL' | 'AUDIT' | 'COMMUNICATION' | 'NOTE';

const ENTRY_ICON = {
  AUDIT: FileText,
  COMMUNICATION: MessageSquare,
  NOTE: StickyNote,
};

const ENTRY_LABEL = {
  AUDIT: 'System Activity',
  COMMUNICATION: 'Communication',
  NOTE: 'Internal Note',
};

/** A null value is either genuinely absent or server-redacted — never render the literal string "null". */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Load Detail's Activity History tab (UI_UX_DESIGN.md §5.4.4, Decision
 * LD-6). Visible to every role — the container never gates this tab
 * (matches the backend's unrestricted GET :id/activity-history). Financial
 * redaction on AUDIT-type entries happens entirely server-side; this
 * component only needs to render whatever it receives, including nulled
 * financial fields, as "—".
 */
export function ActivityHistoryTab({ load }: { load: Load }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [addingNote, setAddingNote] = useState(false);
  const [loggingCommunication, setLoggingCommunication] = useState(false);

  const { data: entries = [] } = useQuery({
    queryKey: ['activity-history', load.id],
    queryFn: () => activityApi.getHistory(load.id),
  });
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });
  const userName = (id: string | null) =>
    id ? (memberships.find((m) => m.userId === id)?.user.name ?? id) : 'System';

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ['activity-history', load.id] });
  }

  const canLog = can('logLoadActivity');
  const counts = {
    AUDIT: entries.filter((e) => e.type === 'AUDIT').length,
    COMMUNICATION: entries.filter((e) => e.type === 'COMMUNICATION').length,
    NOTE: entries.filter((e) => e.type === 'NOTE').length,
  };
  const filtered = filter === 'ALL' ? entries : entries.filter((e) => e.type === filter);

  function renderEntry(entry: ActivityTimelineEntry) {
    const Icon = ENTRY_ICON[entry.type];
    if (entry.type === 'NOTE') {
      return (
        <div key={entry.id} className="activity-history-entry activity-history-entry-note">
          {entryHeader(entry, entry.authorUserId)}
          <div className="activity-history-entry-body">{entry.content}</div>
        </div>
      );
    }
    if (entry.type === 'COMMUNICATION') {
      return (
        <div key={entry.id} className="activity-history-entry activity-history-entry-communication">
          {entryHeader(entry, entry.loggedByUserId)}
          <div className="activity-history-entry-body">
            {entry.activityType}
            {entry.direction ? ` — ${entry.direction === 'INBOUND' ? 'Inbound' : 'Outbound'}` : ''}
            {entry.contactPerson ? ` — ${entry.contactPerson}` : ''}
          </div>
          <div className="activity-history-entry-body">{entry.notes}</div>
        </div>
      );
    }
    const fields = Object.entries(entry.newValue ?? {});
    return (
      <div key={entry.id} className="activity-history-entry activity-history-entry-audit">
        {entryHeader(entry, entry.actorUserId)}
        <div className="activity-history-entry-body">{entry.action}</div>
        {fields.length > 0 ? (
          <div className="activity-history-audit-fields">
            {fields.map(([key, value]) => (
              <span key={key} className="activity-history-audit-field">
                {key}: {displayValue(value)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );

    function entryHeader(e: ActivityTimelineEntry, actorId: string | null) {
      return (
        <>
          <div className="activity-history-entry-top">
            <span className="activity-history-entry-type">
              <Icon size={14} />
              {ENTRY_LABEL[e.type]}
            </span>
            <span className="activity-history-entry-timestamp">{formatDateShort(e.timestamp)}</span>
          </div>
          <div className="activity-history-entry-author">{userName(actorId)}</div>
        </>
      );
    }
  }

  return (
    <div>
      {canLog ? (
        <div className="activity-history-actions">
          <Button variant="tertiary" size="sm" onClick={() => setAddingNote(true)}>
            + Add Internal Note
          </Button>
          <Button variant="tertiary" size="sm" onClick={() => setLoggingCommunication(true)}>
            + Log Communication Activity
          </Button>
        </div>
      ) : null}

      <div className="activity-history-filters">
        <FilterChip label="All" active={filter === 'ALL'} onClick={() => setFilter('ALL')} />
        <FilterChip
          label="System Activity"
          count={counts.AUDIT}
          active={filter === 'AUDIT'}
          onClick={() => setFilter(filter === 'AUDIT' ? 'ALL' : 'AUDIT')}
        />
        <FilterChip
          label="Communications"
          count={counts.COMMUNICATION}
          active={filter === 'COMMUNICATION'}
          onClick={() => setFilter(filter === 'COMMUNICATION' ? 'ALL' : 'COMMUNICATION')}
        />
        <FilterChip
          label="Internal Notes"
          count={counts.NOTE}
          active={filter === 'NOTE'}
          onClick={() => setFilter(filter === 'NOTE' ? 'ALL' : 'NOTE')}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="detail-card">No activity recorded yet.</div>
      ) : (
        <div className="activity-history-timeline">
          {filtered.map((entry) => renderEntry(entry))}
        </div>
      )}

      <AddInternalNoteModal
        open={addingNote}
        loadId={load.id}
        onClose={() => setAddingNote(false)}
        onAdded={() => {
          setAddingNote(false);
          refetch();
        }}
      />
      <LogCommunicationActivityModal
        open={loggingCommunication}
        loadId={load.id}
        onClose={() => setLoggingCommunication(false)}
        onAdded={() => {
          setLoggingCommunication(false);
          refetch();
        }}
      />
    </div>
  );
}
