import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { customersApi, type CustomerStatus } from '../../api';
import { Badge, Button, DataTable } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/ListPage.css';

const STATUS_OPTIONS: { value: CustomerStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'BLOCKED', label: 'Blocked' },
];

const PAGE_SIZE_DEFAULT = 25;

/**
 * No locked screen design exists for this list (approved plan §7
 * decision 2) — built against the Dispatch Board Table View convention
 * (search + status filter, dense table, status badges, kebab-free
 * simple row click, client-side pagination since GET /customers returns
 * an unpaginated array).
 */
export function CustomerListPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<CustomerStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ['customers', { status, search }],
    queryFn: () => customersApi.list({ status: status || undefined, search: search || undefined }),
  });

  const pageRows = useMemo(
    () => customers.slice((page - 1) * pageSize, page * pageSize),
    [customers, page, pageSize],
  );

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Customers</h1>
        {can('manageCustomers') ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={() => navigate('/import?entityType=CUSTOMER')}>
              Bulk Import
            </Button>
            <Button onClick={() => navigate('/customers/new')}>+ New Customer</Button>
          </div>
        ) : null}
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
            setStatus(e.target.value as CustomerStatus | '');
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
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
        emptyMessage="No customers match your filters."
        columns={[
          { key: 'legalName', header: 'Legal Name', render: (r) => r.legalName },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status}
                color={getStatusBadgeColor('Customer.status', r.status) ?? 'neutral'}
              />
            ),
          },
          { key: 'contact', header: 'Primary Contact', render: (r) => r.primaryContactName },
          {
            key: 'city',
            header: 'City / State',
            render: (r) => `${r.billingCity}, ${r.billingState}`,
          },
        ]}
        pagination={{
          page,
          pageSize,
          total: customers.length,
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
