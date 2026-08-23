import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { billingApi } from '../../../api';
import { Badge, DataTable } from '../../../components/ui';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';

/**
 * Scoped-down read-only Invoices table (approved plan §7 decision 4).
 * `total`/`remainingBalance` render as "—" when `null` — the backend's
 * redaction signal for a Sales/Booking caller on a non-own-deal invoice,
 * never $0.00. Rows link to the Frontend Phase 4 Invoice Detail page,
 * but only when `total != null` — a redacted (non-own-deal) row would
 * 403 on direct access, matching the locked "status-only, not
 * independently linkable" rule for those rows.
 */
export function InvoicesTab({ customerId }: { customerId: string }) {
  const navigate = useNavigate();
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', { customerId }],
    queryFn: () => billingApi.listInvoices({ customerId }),
  });

  return (
    <DataTable
      loading={isLoading}
      rows={invoices}
      rowKey={(r) => r.id}
      onRowClick={(r) => {
        if (r.total != null) navigate(`/billing/invoices/${r.id}`);
      }}
      emptyMessage="No invoices yet."
      columns={[
        { key: 'invoiceNumber', header: 'Invoice #', render: (r) => r.invoiceNumber },
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
    />
  );
}
