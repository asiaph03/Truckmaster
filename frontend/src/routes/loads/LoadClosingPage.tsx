import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadsApi } from '../../api';
import { ApiError } from '../../api/errors';
import { Breadcrumb, Button, ChecklistItem } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';

/**
 * UI_UX_DESIGN.md §5.4.8 Load Closing — single-column, fixed-width card,
 * no tables. The checklist is purely informational (Workflow 10 §10.6:
 * "there is no hard blocker anywhere in this workflow") — Close Load is
 * always enabled and needs no confirmation modal; the checklist view
 * itself plus the explicit click is the required acknowledgment.
 */
export function LoadClosingPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [closing, setClosing] = useState(false);

  const { data: load } = useQuery({
    queryKey: ['loads', id],
    queryFn: () => loadsApi.getById(id),
    enabled: Boolean(id),
  });
  const { data: checklistData, isLoading: checklistLoading } = useQuery({
    queryKey: ['loads', id, 'closing-checklist'],
    queryFn: () => loadsApi.getClosingChecklist(id),
    enabled: Boolean(id),
  });

  async function onClose() {
    setClosing(true);
    try {
      await loadsApi.close(id);
      toast.success('Load closed.');
      await queryClient.invalidateQueries({ queryKey: ['loads', id] });
      navigate(`/loads/${id}`);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setClosing(false);
    }
  }

  if (!load) return <div>Loading…</div>;

  if (load.status === 'CLOSED') {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Breadcrumb
          items={[
            { label: 'Loads', to: '/loads/board' },
            { label: load.loadNumber, to: `/loads/${id}` },
            { label: 'Close' },
          ]}
        />
        <div className="detail-card">
          <h2 className="detail-card-title">This load is already closed.</h2>
          <Button variant="secondary" onClick={() => navigate(`/loads/${id}`)}>
            Back to Load Detail
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <Breadcrumb
        items={[
          { label: 'Loads', to: '/loads/board' },
          { label: load.loadNumber, to: `/loads/${id}` },
          { label: 'Close' },
        ]}
      />
      <div className="detail-card">
        <h2 className="detail-card-title">Close {load.loadNumber}</h2>
        {checklistLoading || !checklistData ? (
          <span className="detail-field-value">Loading…</span>
        ) : (
          checklistData.checklist.map((item) => (
            <ChecklistItem
              key={item.item}
              label={item.item}
              state={item.status === 'CLEAN' ? 'clean' : 'warning'}
              detail={
                item.remainingCarrierBalance
                  ? `${item.detail} — $${item.remainingCarrierBalance} remaining`
                  : item.detail
              }
            />
          ))
        )}
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
          <Button loading={closing} onClick={onClose}>
            Close Load
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/loads/${id}`)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
