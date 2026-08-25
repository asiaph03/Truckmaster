import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { billingApi, type InvoiceStatus } from '../../api';
import { Badge, DataTable } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/ListPage.css';

const STATUS_OPTIONS: { value: InvoiceStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CREDITED', label: 'Credited' },
  { value: 'VOID', label: 'Void' },
];

const PAGE_SIZE_DEFAULT = 25;

/**
 * No standalone Invoice List screen was ever designed (only the Invoice
 * Builder's own in-flow Ready-to-Invoice queue, §5.4.7a) — built against
 * the same list-page convention every other undesigned Phase 3/4 screen
 * uses. "+ New Invoice" lives on the Builder page itself, reached from
 * here or from a Load's Financials tab.
 */
export function InvoiceListPage() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', { status }],
    queryFn: () => billingApi.listInvoices({ status: status || undefined }),
  });

  const pageRows = useMemo(
    () => invoices.slice((page - 1) * pageSize, page * pageSize),
    [invoices, page, pageSize],
  );

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Invoices</h1>
        {can('viewArApAging') ? <Link to="/billing/ar-aging">AR Aging →</Link> : null}
      </div>

      <div className="list-page-toolbar">
        <select
          className="field-select list-page-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as InvoiceStatus | '');
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
        onRowClick={(row) => navigate(`/billing/invoices/${row.id}`)}
        emptyMessage="No invoices match your filters."
        columns={[
          { key: 'invoiceNumber', header: 'Invoice #', render: (r) => r.invoiceNumber },
          {
            key: 'customer',
            header: 'Customer',
            render: (r) => r.customer?.legalName ?? '—',
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status}
                color={getStatusBadgeColor('Invoice.status', r.status) ?? 'neutral'}
              />
            ),
          },
          {
            key: 'total',
            header: 'Total',
            numeric: true,
            render: (r) => (r.total != null ? `$${r.total}` : '—'),
          },
          {
            key: 'balance',
            header: 'Balance',
            numeric: true,
            render: (r) => (r.remainingBalance != null ? `$${r.remainingBalance}` : '—'),
          },
          {
            key: 'dueDate',
            header: 'Due Date',
            render: (r) => (r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'),
          },
        ]}
        pagination={{
          page,
          pageSize,
          total: invoices.length,
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
