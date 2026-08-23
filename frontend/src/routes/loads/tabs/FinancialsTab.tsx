import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { billingApi, carrierPayApi, type ChargeLineItem, type Load } from '../../../api';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import { Badge, Button, DataTable } from '../../../components/ui';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatDateShort } from '../loadDerived';
import { AddChargeModal } from '../modals/AddChargeModal';
import { CreateCarrierPaymentModal } from '../modals/CreateCarrierPaymentModal';
import '../../shared/DetailPage.css';

const DELIVERED_OR_LATER = ['DELIVERED', 'CLOSED'];

function chargeColumns(chargeTypeLabel: (id: string) => string) {
  return [
    { key: 'type', header: 'Type', render: (c: ChargeLineItem) => chargeTypeLabel(c.chargeTypeId) },
    {
      key: 'description',
      header: 'Description',
      render: (c: ChargeLineItem) => c.description || '—',
    },
    { key: 'qty', header: 'Qty', render: (c: ChargeLineItem) => c.quantity },
    {
      key: 'unitRate',
      header: 'Unit Rate',
      render: (c: ChargeLineItem) => `$${c.unitRate}`,
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (c: ChargeLineItem) => (c.amount != null ? `$${c.amount}` : '—'),
    },
    {
      key: 'source',
      header: 'Source',
      render: (c: ChargeLineItem) => <Badge label={c.source} color="neutral" />,
    },
  ];
}

/**
 * UI_UX_DESIGN.md §5.4.4 Financials tab. Fully hidden for Dispatcher at
 * the container level (LoadDetailPage decides tab visibility) — nothing
 * in here needs its own Dispatcher check. The Customer Invoice card
 * resolves the actual invoice for this Load by listing the customer's
 * invoices and checking each one's `invoiceLoads` (no endpoint filters
 * invoices by loadId directly) — bounded by that one customer's invoice
 * count, not global.
 */
export function FinancialsTab({ load, onChanged }: { load: Load; onChanged: () => void }) {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [addingCharge, setAddingCharge] = useState(false);
  const [creatingCarrierPayment, setCreatingCarrierPayment] = useState(false);

  const { data: chargeTypes = [] } = useQuery({
    queryKey: ['charge-types'],
    queryFn: () => billingApi.listChargeTypes(),
  });
  /**
   * Falls back to "—", never the raw `chargeTypeId` — `GET /charge-types`
   * 403s for Sales/Booking (Decision Log D9's view role set excludes
   * them), leaving `chargeTypes` empty, which previously leaked the raw
   * UUID into this column for that role. Caught during Phase 4 manual
   * smoke testing.
   */
  const chargeTypeLabel = (id: string) => chargeTypes.find((t) => t.id === id)?.label ?? '—';

  /**
   * Backend VIEW_ROLES for GET /carrier-payments is ADMIN/ACCOUNTING/
   * OPERATIONS_MANAGER — the same role set as `viewLoadFinancials` here.
   * Previously this query ran unconditionally and, for a role like
   * Sales/Booking that 403s, `data` fell back to the query's default `[]`,
   * rendering a misleading "No carrier payments yet." instead of hiding
   * the section. Caught during Phase 4 manual smoke testing.
   */
  const canViewCarrierPay = can('viewLoadFinancials');
  const { data: carrierPayments = [], refetch: refetchCarrierPayments } = useQuery({
    queryKey: ['carrier-payments', { loadId: load.id }],
    queryFn: () => carrierPayApi.list({ loadId: load.id }),
    enabled: canViewCarrierPay,
  });

  const { data: matchingInvoice } = useQuery({
    queryKey: ['invoice-for-load', load.id],
    queryFn: async () => {
      const summaries = await billingApi.listInvoices({ customerId: load.customerId });
      const details = await Promise.all(summaries.map((s) => billingApi.getInvoiceById(s.id)));
      return details.find((d) => d.invoiceLoads.some((il) => il.loadId === load.id)) ?? null;
    },
    enabled: load.invoiced,
  });

  const customerCharges = load.chargeLineItems.filter((c) => c.side === 'CUSTOMER');
  const carrierCharges = load.chargeLineItems.filter((c) => c.side === 'CARRIER');
  const customerTotal = customerCharges.every((c) => c.amount != null)
    ? customerCharges.reduce((sum, c) => sum + Number(c.amount), 0)
    : null;
  const carrierTotal = carrierCharges.every((c) => c.amount != null)
    ? carrierCharges.reduce((sum, c) => sum + Number(c.amount), 0)
    : null;
  const grossProfit =
    customerTotal != null && carrierTotal != null ? customerTotal - carrierTotal : null;
  const marginPct =
    grossProfit != null && customerTotal !== 0 && customerTotal != null
      ? (grossProfit / customerTotal) * 100
      : null;

  const canAddCharge = can('addChargeToLoad');
  const canManageInvoice = can('sendOrVoidInvoice');
  const canManageCarrierPay = can('createOrSubmitCarrierPayment');
  const deliveredOrLater = DELIVERED_OR_LATER.includes(load.status);

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Charge Line Items — Customer
        </h2>
        {canAddCharge ? (
          <Button variant="tertiary" size="sm" onClick={() => setAddingCharge(true)}>
            + Add Charge
          </Button>
        ) : null}
      </div>
      <DataTable
        rows={customerCharges}
        rowKey={(c) => c.id}
        emptyMessage="No customer-side charges yet."
        columns={chargeColumns(chargeTypeLabel)}
      />

      <h2 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
        Charge Line Items — Carrier
      </h2>
      <DataTable
        rows={carrierCharges}
        rowKey={(c) => c.id}
        emptyMessage="No carrier-side charges yet."
        columns={chargeColumns(chargeTypeLabel)}
      />

      {grossProfit != null ? (
        <div className="detail-card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="detail-card-grid">
            <div>
              <div className="detail-field-label">Gross Profit</div>
              <div className="detail-field-value">${grossProfit.toFixed(2)}</div>
            </div>
            {marginPct != null ? (
              <div>
                <div className="detail-field-label">Margin %</div>
                <div className="detail-field-value">{marginPct.toFixed(1)}%</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="detail-card">
        <h2 className="detail-card-title">Customer Invoice</h2>
        {load.invoiced && matchingInvoice ? (
          <div className="detail-card-grid">
            <div>
              <div className="detail-field-label">Invoice</div>
              <div className="detail-field-value">
                <Link to={`/billing/invoices/${matchingInvoice.id}`}>
                  {matchingInvoice.invoiceNumber}
                </Link>
              </div>
            </div>
            <div>
              <div className="detail-field-label">Status</div>
              <Badge
                label={matchingInvoice.status}
                color={getStatusBadgeColor('Invoice.status', matchingInvoice.status) ?? 'neutral'}
              />
            </div>
          </div>
        ) : load.invoiced ? (
          <span className="detail-field-value">Invoiced.</span>
        ) : (
          <>
            <span className="detail-field-value">Not yet invoiced.</span>
            {canManageInvoice ? (
              <div style={{ marginTop: 'var(--space-3)' }}>
                <Button
                  size="sm"
                  disabled={!deliveredOrLater}
                  title={!deliveredOrLater ? 'Available once the load is Delivered.' : undefined}
                  onClick={() => navigate(`/billing/invoices/new?loadId=${load.id}`)}
                >
                  Create Invoice
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {canViewCarrierPay ? (
        <div className="detail-card">
          <div className="detail-section-header">
            <h2 className="detail-card-title" style={{ margin: 0 }}>
              Carrier Payments
            </h2>
            {canManageCarrierPay ? (
              <Button
                variant="tertiary"
                size="sm"
                disabled={!deliveredOrLater || !load.assignedCarrierId}
                title={!deliveredOrLater ? 'Available once the load is Delivered.' : undefined}
                onClick={() => setCreatingCarrierPayment(true)}
              >
                + Add Carrier Payment
              </Button>
            ) : null}
          </div>
          <DataTable
            rows={carrierPayments}
            rowKey={(p) => p.id}
            emptyMessage="No carrier payments yet."
            columns={[
              { key: 'type', header: 'Type', render: (p) => p.paymentType },
              { key: 'amount', header: 'Amount', render: (p) => `$${p.amount}` },
              {
                key: 'status',
                header: 'Status',
                render: (p) => (
                  <Badge
                    label={p.status.replace('_', ' ')}
                    color={getStatusBadgeColor('CarrierPayment.status', p.status) ?? 'neutral'}
                  />
                ),
              },
              { key: 'createdAt', header: 'Created', render: (p) => formatDateShort(p.createdAt) },
              {
                key: 'actions',
                header: '',
                render: (p) => <Link to={`/billing/carrier-pay/${p.id}`}>View</Link>,
              },
            ]}
          />
        </div>
      ) : null}

      <AddChargeModal
        open={addingCharge}
        loadId={load.id}
        onClose={() => setAddingCharge(false)}
        onAdded={() => {
          setAddingCharge(false);
          onChanged();
        }}
      />
      <CreateCarrierPaymentModal
        open={creatingCarrierPayment}
        loadId={load.id}
        onClose={() => setCreatingCarrierPayment(false)}
        onCreated={() => {
          setCreatingCarrierPayment(false);
          refetchCarrierPayments();
          queryClient.invalidateQueries({ queryKey: ['carrier-payments'] });
        }}
      />
    </div>
  );
}
