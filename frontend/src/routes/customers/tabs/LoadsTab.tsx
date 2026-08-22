import { useQuery } from '@tanstack/react-query';
import { loadsApi } from '../../../api';
import { Badge, DataTable } from '../../../components/ui';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import { usePermissions } from '../../../hooks/usePermissions';

/**
 * Scoped-down read-only Loads table (approved plan §7 decision 4) — the
 * subset of columns available from `GET /loads?customerId=` today, not
 * the full Dispatch Board. Shared by Customer Detail and Carrier Detail.
 */
export function LoadsTab({ customerId, carrierId }: { customerId?: string; carrierId?: string }) {
  const { can } = usePermissions();
  const canSeeFinancials = can('viewLoadFinancials');

  const { data: loads = [], isLoading } = useQuery({
    queryKey: ['loads', { customerId, carrierId }],
    queryFn: () => loadsApi.list({ customerId, carrierId }),
  });

  return (
    <DataTable
      loading={isLoading}
      rows={loads}
      rowKey={(r) => r.id}
      emptyMessage="No loads yet."
      columns={[
        { key: 'loadNumber', header: 'Load #', render: (r) => r.loadNumber },
        {
          key: 'status',
          header: 'Status',
          render: (r) => (
            <Badge
              label={r.status}
              color={getStatusBadgeColor('Load.status', r.status) ?? 'neutral'}
            />
          ),
        },
        { key: 'equipment', header: 'Equipment', render: (r) => r.equipmentType.replace('_', ' ') },
        {
          key: 'customerRate',
          header: 'Customer Rate',
          numeric: true,
          render: (r) => (canSeeFinancials && r.customerRate != null ? `$${r.customerRate}` : '—'),
        },
        ...(carrierId
          ? [
              {
                key: 'carrierRate',
                header: 'Carrier Rate',
                numeric: true,
                render: (r: (typeof loads)[number]) =>
                  canSeeFinancials && r.carrierRate != null ? `$${r.carrierRate}` : '—',
              },
            ]
          : []),
        {
          key: 'createdAt',
          header: 'Booked',
          render: (r) => new Date(r.createdAt).toLocaleDateString(),
        },
      ]}
    />
  );
}
