import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { carrierPayApi, type CarrierPaymentStatus } from '../../api';
import { Badge, DataTable } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import '../shared/ListPage.css';

const STATUS_OPTIONS: { value: CarrierPaymentStatus | ''; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'PAID', label: 'Paid' },
];

const PAGE_SIZE_DEFAULT = 25;

/**
 * No locked design exists for a standalone Carrier Payment List (an
 * acknowledged prototype gap — the Approve/Reject reviewer UI was never
 * specified beyond "stops at Pending Approval on submission"). Built
 * against the same list-page convention every other undesigned
 * Phase 3/4 screen uses. Creation only happens from a Load's Financials
 * tab (the backend has no bare `POST /carrier-payments`), so there's no
 * "+ New" action here.
 */
export function CarrierPaymentListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<CarrierPaymentStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ['carrier-payments', { status }],
    queryFn: () => carrierPayApi.list({ status: status || undefined }),
  });

  const pageRows = useMemo(
    () => payments.slice((page - 1) * pageSize, page * pageSize),
    [payments, page, pageSize],
  );

  return (
    <div>
      <div className="list-page-header">
        <h1 className="list-page-title">Carrier Payments</h1>
      </div>

      <div className="list-page-toolbar">
        <select
          className="field-select list-page-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as CarrierPaymentStatus | '');
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
        onRowClick={(row) => navigate(`/billing/carrier-pay/${row.id}`)}
        emptyMessage="No carrier payments match your filters."
        columns={[
          { key: 'type', header: 'Type', render: (r) => r.paymentType },
          { key: 'amount', header: 'Amount', numeric: true, render: (r) => `$${r.amount}` },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.status.replace('_', ' ')}
                color={getStatusBadgeColor('CarrierPayment.status', r.status) ?? 'neutral'}
              />
            ),
          },
          {
            key: 'createdAt',
            header: 'Created',
            render: (r) => new Date(r.createdAt).toLocaleDateString(),
          },
        ]}
        pagination={{
          page,
          pageSize,
          total: payments.length,
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
