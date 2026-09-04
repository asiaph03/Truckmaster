import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { billingApi, membershipsApi, type Load } from '../../api';
import { Badge, Button, DataTable } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { formatDateShort } from './loadDerived';
import { AddChargeModal } from './modals/AddChargeModal';
import '../shared/DetailPage.css';

/**
 * Accessorial Charges on in-transit Loads. A standalone card, deliberately
 * NOT gated behind the Financials tab (which is fully hidden for
 * Dispatcher, LoadDetailPage.tsx) — Dispatcher already holds the
 * `addChargeToLoad` permission server-side (Decision Log D9's
 * ADD_CHARGE_ROLES includes Dispatcher) but previously had no UI surface
 * to use it from. Rendered on the Overview tab, which is visible to every
 * role.
 *
 * Reuses the existing `ChargeLineItem` model/API/modal as-is — this only
 * filters `load.chargeLineItems` down to `source: 'ADJUSTMENT'` (the
 * accessorials added after booking) so the two system-created `ORIGINAL`
 * linehaul rows don't clutter a section titled "Accessorial Charges."
 * Amount visibility is exactly what the server already redacts per-row
 * via `shapeFinancialFields` (financial-field-shaping.ts) — no extra
 * frontend redaction logic needed: Dispatcher already receives `amount:
 * null` on every row regardless of side, so it renders as "—" here the
 * same way it does on the Financials tab.
 */
export function AccessorialChargesCard({ load, onChanged }: { load: Load; onChanged: () => void }) {
  const { can } = usePermissions();
  const [addingCharge, setAddingCharge] = useState(false);

  const { data: chargeTypes = [] } = useQuery({
    queryKey: ['charge-types'],
    queryFn: () => billingApi.listChargeTypes(),
  });
  const chargeTypeLabel = (id: string) => chargeTypes.find((t) => t.id === id)?.label ?? '—';

  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });
  const addedByName = (userId: string) =>
    memberships.find((m) => m.userId === userId)?.user.name ?? '—';

  const canAddCharge = can('addChargeToLoad');
  const accessorials = load.chargeLineItems.filter((c) => c.source === 'ADJUSTMENT');

  return (
    <div className="detail-card">
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Accessorial Charges
        </h2>
        {canAddCharge ? (
          <Button variant="tertiary" size="sm" onClick={() => setAddingCharge(true)}>
            + Add Charge
          </Button>
        ) : null}
      </div>
      <DataTable
        rows={accessorials}
        rowKey={(c) => c.id}
        emptyMessage="No accessorial charges yet."
        columns={[
          { key: 'type', header: 'Type', render: (c) => chargeTypeLabel(c.chargeTypeId) },
          {
            key: 'side',
            header: 'Side',
            render: (c) => (
              <Badge label={c.side === 'CUSTOMER' ? 'Customer' : 'Carrier'} color="neutral" />
            ),
          },
          {
            key: 'amount',
            header: 'Amount',
            render: (c) => (c.amount != null ? `$${c.amount}` : '—'),
          },
          { key: 'notes', header: 'Notes', render: (c) => c.notes || c.description || '—' },
          { key: 'addedBy', header: 'Added By', render: (c) => addedByName(c.createdByUserId) },
          { key: 'addedAt', header: 'Added', render: (c) => formatDateShort(c.createdAt) },
        ]}
      />

      <AddChargeModal
        open={addingCharge}
        loadId={load.id}
        onClose={() => setAddingCharge(false)}
        onAdded={() => {
          setAddingCharge(false);
          onChanged();
        }}
      />
    </div>
  );
}
