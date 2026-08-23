import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { quotesApi, type QuoteStatus } from '../../api';
import { Badge, Button, DataTable } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/ListPage.css';

const STATUS_OPTIONS: { value: QuoteStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
];

const PAGE_SIZE_DEFAULT = 25;

/** No locked screen design exists (approved plan §7 decision 3) — built against the Phase 2 list-page convention. */
export function QuoteListPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [status, setStatus] = useState<QuoteStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const { data: quotes = [], isLoading } = useQuery({
    queryKey: ['quotes', { status }],
    queryFn: () => quotesApi.list({ status: status || undefined }),
  });

  const pageRows = useMemo(
    () => quotes.slice((page - 1) * pageSize, page * pageSize),
    [quotes, page, pageSize],
  );

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Quotes</h1>
        {can('createQuoteOrLoad') ? (
          <Button onClick={() => navigate('/quotes/new')}>+ New Quote</Button>
        ) : null}
      </div>

      <div className="list-page-toolbar">
        <select
          className="field-select list-page-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as QuoteStatus | '');
            setPage(1);
          }}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        loading={isLoading}
        rows={pageRows}
        rowKey={(row) => row.id}
        onRowClick={(row) => navigate(`/quotes/${row.id}`)}
        emptyMessage="No quotes match your filters."
        columns={[
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status}
                color={getStatusBadgeColor('Quote.status', r.status) ?? 'neutral'}
              />
            ),
          },
          {
            key: 'equipment',
            header: 'Equipment',
            render: (r) => r.equipmentType.replace('_', ' '),
          },
          {
            key: 'rate',
            header: 'Rate',
            numeric: true,
            render: (r) => (r.customerRate != null ? `$${r.customerRate}` : '—'),
          },
          {
            key: 'expiration',
            header: 'Expires',
            render: (r) => new Date(r.expirationDate).toLocaleDateString(),
          },
        ]}
        pagination={{
          page,
          pageSize,
          total: quotes.length,
          onPageChange: setPage,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
        }}
      />
    </div>
  );
}
