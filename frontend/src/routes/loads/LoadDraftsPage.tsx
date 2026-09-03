import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadDraftsApi } from '../../api';
import { Badge, Breadcrumb, Button, DataTable } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import '../shared/ListPage.css';

/**
 * Rate Confirmation → New Load auto-populate feature — Load Draft list.
 * The only way back to a draft saved while a resolved Customer awaited
 * approval; each row's "Ready to Book" badge is the customer's LIVE
 * status (never a separately-tracked draft status — see loadDrafts.ts's
 * own doc comment).
 */
export function LoadDraftsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: drafts = [], isLoading } = useQuery({
    queryKey: ['load-drafts'],
    queryFn: () => loadDraftsApi.list(),
  });

  async function handleDelete(id: string) {
    await loadDraftsApi.remove(id);
    queryClient.invalidateQueries({ queryKey: ['load-drafts'] });
  }

  return (
    <div>
      <Breadcrumb items={[{ label: 'Loads', to: '/loads/board' }, { label: 'Load Drafts' }]} />
      <div className="list-page-header">
        <h1 className="list-page-title">Load Drafts</h1>
        <Button onClick={() => navigate('/loads/new')}>+ New Load</Button>
      </div>

      <DataTable
        loading={isLoading}
        rows={drafts}
        rowKey={(row) => row.id}
        onRowClick={(row) => navigate(`/loads/new?draftId=${row.id}`)}
        emptyMessage="No Load Drafts — these appear here automatically when an uploaded Rate Confirmation's customer isn't Active yet."
        columns={[
          { key: 'customer', header: 'Customer', render: (r) => r.customerLegalName },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <Badge
                label={r.customerStatus === 'ACTIVE' ? 'Ready to Book' : r.customerStatus}
                color={getStatusBadgeColor('Customer.status', r.customerStatus) ?? 'neutral'}
              />
            ),
          },
          { key: 'file', header: 'Rate Confirmation', render: (r) => r.rateConfirmationFileName },
          {
            key: 'created',
            header: 'Created',
            render: (r) => new Date(r.createdAt).toLocaleString(),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <Button
                variant="tertiary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(r.id);
                }}
              >
                Delete
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
