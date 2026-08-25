import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { carriersApi, type CarrierStatus } from '../../api';
import { Badge, Button, DataTable, EligibilityBadge } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/ListPage.css';

const STATUS_OPTIONS: { value: CarrierStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'BLOCKED', label: 'Blocked' },
];

const PAGE_SIZE_DEFAULT = 25;

/** No locked screen design exists for this list (approved plan §7 decision 2) — see CustomerListPage. */
export function CarrierListPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [status, setStatus] = useState<CarrierStatus | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const { data: carriers = [], isLoading } = useQuery({
    queryKey: ['carriers', { status }],
    queryFn: () => carriersApi.list({ status: status || undefined }),
  });

  const filtered = useMemo(
    () =>
      search
        ? carriers.filter((c) => c.legalName.toLowerCase().includes(search.toLowerCase()))
        : carriers,
    [carriers, search],
  );
  const pageRows = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Carriers</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
          {can('reviewComplianceDocuments') ? (
            <Link to="/carriers/compliance-queue">Compliance Queue →</Link>
          ) : null}
          {can('manageCarriers') ? (
            <Button onClick={() => navigate('/carriers/new')}>+ New Carrier</Button>
          ) : null}
        </div>
      </div>

      <div className="list-page-toolbar">
        <div className="list-page-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            placeholder="Search by legal name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <select
          className="field-select list-page-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as CarrierStatus | '');
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
        onRowClick={(row) => navigate(`/carriers/${row.id}`)}
        emptyMessage="No carriers match your filters."
        columns={[
          { key: 'legalName', header: 'Legal Name', render: (r) => r.legalName },
          { key: 'mcNumber', header: 'MC #', render: (r) => r.mcNumber },
          { key: 'dotNumber', header: 'DOT #', render: (r) => r.dotNumber },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status}
                color={getStatusBadgeColor('Carrier.status', r.status) ?? 'neutral'}
              />
            ),
          },
          {
            key: 'eligibility',
            header: 'Eligibility',
            render: (r) => (
              <EligibilityBadge eligible={r.assignmentEligible} reasons={r.ineligibilityReasons} />
            ),
          },
        ]}
        pagination={{
          page,
          pageSize,
          total: filtered.length,
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
