import { useMemo, useState } from 'react';
import { Truck } from 'lucide-react';
import { loadsApi, type LoadSummary, type LoadStatus } from '../../api';
import { ApiError } from '../../api/errors';
import { Badge, ConfirmDialog, RowActionsMenu } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { firstPickupDate, formatDateShort, isWithinHours, lastDeliveryDate } from './loadDerived';
import { AssignCarrierModal } from './modals/AssignCarrierModal';
import { DispatchModal } from './modals/DispatchModal';
import { GenerateRateConfirmationModal } from './modals/GenerateRateConfirmationModal';
import './KanbanBoard.css';

const COLUMNS: { status: LoadStatus; label: string }[] = [
  { status: 'BOOKED', label: 'Booked' },
  { status: 'CARRIER_SOURCING', label: 'Carrier Sourcing' },
  { status: 'CARRIER_ASSIGNED', label: 'Carrier Assigned' },
  { status: 'RATE_CONFIRMATION', label: 'Rate Confirmation' },
  { status: 'DISPATCHED', label: 'Dispatched' },
  { status: 'PICKUP', label: 'Pickup' },
  { status: 'IN_TRANSIT', label: 'In Transit' },
  { status: 'DELIVERED', label: 'Delivered' },
];
const CLOSED_COLUMN: { status: LoadStatus; label: string } = { status: 'CLOSED', label: 'Closed' };

// UI_UX_DESIGN.md §5.4.2 drag table — cards in these statuses have no
// valid manual transition out of them (derived-status columns, or
// DELIVERED which only leaves via the full Load Closing checklist, not
// a drag), so they are never drag-sources at all.
const NOT_DRAG_SOURCES = new Set<LoadStatus>([
  'DISPATCHED',
  'PICKUP',
  'IN_TRANSIT',
  'DELIVERED',
  'CLOSED',
]);
const SYSTEM_DERIVED_TARGETS = new Set<LoadStatus>(['PICKUP', 'IN_TRANSIT', 'DELIVERED']);

function validTargets(status: LoadStatus): LoadStatus[] {
  switch (status) {
    case 'BOOKED':
      return ['CARRIER_SOURCING'];
    case 'CARRIER_SOURCING':
      return ['CARRIER_ASSIGNED'];
    case 'CARRIER_ASSIGNED':
      return ['RATE_CONFIRMATION', 'CARRIER_SOURCING'];
    case 'RATE_CONFIRMATION':
      return ['DISPATCHED'];
    default:
      return [];
  }
}

function keyDate(load: LoadSummary): string | null {
  const useDelivery = load.status === 'IN_TRANSIT' || load.status === 'DELIVERED';
  return useDelivery ? lastDeliveryDate(load.stops) : firstPickupDate(load.stops);
}

/**
 * UI_UX_DESIGN.md §5.4.2 — Dispatch Board Kanban view. Direct drag only
 * for BOOKED → CARRIER_SOURCING; every other manual transition is
 * "assisted" (opens the exact same modal Load Detail's header action
 * uses — one implementation, two entry points, not a second copy of the
 * transition logic); drops into the system-derived columns
 * (PICKUP/IN_TRANSIT/DELIVERED) or CLOSED are blocked. INT-13's
 * keyboard-accessible alternative ("Move to…") is a kebab menu on each
 * card routing through the identical `attemptMove` handler as the drag
 * path, not a second implementation.
 *
 * No optimistic move — a card only changes column once its mutation
 * actually succeeds and the parent's `loads` query refetches, so a
 * cancelled/blocked drop needs no explicit "snap back": the card was
 * never moved from its rendered column in the first place.
 */
export function KanbanBoard({
  loads,
  canManage,
  showClosed,
  customerName,
  carrierName,
  dispatcherInitial,
  onCardClick,
  onChanged,
}: {
  loads: LoadSummary[];
  canManage: boolean;
  showClosed: boolean;
  customerName: (id: string) => string;
  carrierName: (id?: string) => string;
  dispatcherInitial: (id?: string) => string;
  onCardClick: (load: LoadSummary) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [draggedLoad, setDraggedLoad] = useState<LoadSummary | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<LoadStatus | null>(null);
  const [assigningCarrierFor, setAssigningCarrierFor] = useState<string | null>(null);
  const [generatingRateConfFor, setGeneratingRateConfFor] = useState<string | null>(null);
  const [dispatchingFor, setDispatchingFor] = useState<LoadSummary | null>(null);
  const [rejectingFor, setRejectingFor] = useState<string | null>(null);

  const columns = showClosed ? [...COLUMNS, CLOSED_COLUMN] : COLUMNS;
  const draggedValidTargets = draggedLoad ? new Set(validTargets(draggedLoad.status)) : null;

  const byColumn = useMemo(() => {
    const map = new Map<LoadStatus, LoadSummary[]>();
    for (const col of columns) map.set(col.status, []);
    for (const load of loads) {
      if (!showClosed && load.status === 'CLOSED') continue;
      map.get(load.status)?.push(load);
    }
    for (const [, list] of map) {
      list.sort((a, b) => {
        const da = keyDate(a);
        const db = keyDate(b);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return new Date(da).getTime() - new Date(db).getTime();
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads, showClosed]);

  async function beginSourcingDirect(loadId: string) {
    try {
      await loadsApi.beginSourcing(loadId);
      toast.success('Carrier sourcing begun.');
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  function attemptMove(load: LoadSummary, targetStatus: LoadStatus) {
    if (targetStatus === load.status) return;

    if (SYSTEM_DERIVED_TARGETS.has(targetStatus)) {
      toast.danger(
        'This status advances automatically as pickup/delivery stops are recorded — open the load to update stop status.',
      );
      return;
    }
    if (targetStatus === 'CLOSED') {
      toast.danger(
        'Closing requires the full readiness-checklist review on the Load Closing screen.',
      );
      return;
    }
    if (load.status === 'BOOKED' && targetStatus === 'CARRIER_SOURCING') {
      beginSourcingDirect(load.id);
      return;
    }
    if (load.status === 'CARRIER_SOURCING' && targetStatus === 'CARRIER_ASSIGNED') {
      setAssigningCarrierFor(load.id);
      return;
    }
    if (load.status === 'CARRIER_ASSIGNED' && targetStatus === 'RATE_CONFIRMATION') {
      setGeneratingRateConfFor(load.id);
      return;
    }
    if (load.status === 'CARRIER_ASSIGNED' && targetStatus === 'CARRIER_SOURCING') {
      setRejectingFor(load.id);
      return;
    }
    if (load.status === 'RATE_CONFIRMATION' && targetStatus === 'DISPATCHED') {
      setDispatchingFor(load);
      return;
    }
    toast.danger('This move is not available from the current status.');
  }

  async function onCarrierRejected(reason?: string) {
    if (!rejectingFor) return;
    try {
      await loadsApi.carrierRejected(rejectingFor, { reason: reason ?? '' });
      toast.success('Carrier rejection recorded.');
      setRejectingFor(null);
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <>
      <div className="kanban-board">
        {columns.map((col) => {
          const rows = byColumn.get(col.status) ?? [];
          const isValidTarget = draggedValidTargets?.has(col.status) ?? false;
          return (
            <div
              key={col.status}
              className={[
                'kanban-column',
                draggedLoad && isValidTarget ? 'kanban-column-valid-target' : '',
                dragOverStatus === col.status && isValidTarget ? 'kanban-column-dragover' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onDragOver={(e) => {
                if (!draggedLoad) return;
                e.preventDefault();
                setDragOverStatus(col.status);
              }}
              onDragLeave={() => setDragOverStatus((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverStatus(null);
                const load = draggedLoad;
                setDraggedLoad(null);
                if (load) attemptMove(load, col.status);
              }}
            >
              <div className="kanban-column-header">
                <span>{col.label}</span>
                <span className="kanban-column-count">{rows.length}</span>
              </div>
              <div className="kanban-column-body">
                {rows.length === 0 ? (
                  <div className="kanban-empty">No loads</div>
                ) : (
                  rows.map((load) => {
                    const date = keyDate(load);
                    const urgent = isWithinHours(date, 4);
                    const draggable = canManage && !NOT_DRAG_SOURCES.has(load.status);
                    const options = canManage ? validTargets(load.status) : [];
                    return (
                      <div
                        key={load.id}
                        className={[
                          'kanban-card',
                          load.riskStatus !== 'NORMAL'
                            ? `kanban-card-risk-${load.riskStatus.toLowerCase()}`
                            : '',
                          draggable ? 'kanban-card-draggable' : '',
                          draggedLoad?.id === load.id ? 'kanban-card-dragging' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        draggable={draggable}
                        onDragStart={() => setDraggedLoad(load)}
                        onDragEnd={() => {
                          setDraggedLoad(null);
                          setDragOverStatus(null);
                        }}
                        onClick={() => onCardClick(load)}
                      >
                        <div className="kanban-card-top">
                          <span className="kanban-card-load-number">{load.loadNumber}</span>
                          {options.length > 0 ? (
                            <div onClick={(e) => e.stopPropagation()}>
                              <RowActionsMenu>
                                {options.map((target) => (
                                  <button
                                    key={target}
                                    className="data-table-row-action"
                                    onClick={() => attemptMove(load, target)}
                                  >
                                    {target === 'CARRIER_SOURCING' &&
                                    load.status === 'CARRIER_ASSIGNED'
                                      ? 'Carrier Rejected → Sourcing'
                                      : `Move to ${COLUMNS.find((c) => c.status === target)?.label ?? target}`}
                                  </button>
                                ))}
                              </RowActionsMenu>
                            </div>
                          ) : null}
                        </div>
                        <div className="kanban-card-customer">{customerName(load.customerId)}</div>
                        <div className="kanban-card-row">
                          <Badge
                            label={
                              load.assignedCarrierId
                                ? carrierName(load.assignedCarrierId)
                                : 'Unassigned'
                            }
                            color="neutral"
                          />
                          <span
                            className="kanban-card-equipment"
                            title={load.equipmentType.replace('_', ' ')}
                          >
                            <Truck size={14} strokeWidth={1.5} />
                          </span>
                          {load.assignedDispatcherId ? (
                            <span
                              className="kanban-card-dispatcher"
                              title={dispatcherInitial(load.assignedDispatcherId)}
                            >
                              {dispatcherInitial(load.assignedDispatcherId)
                                .slice(0, 2)
                                .toUpperCase()}
                            </span>
                          ) : null}
                        </div>
                        <div className="kanban-card-driver">
                          Driver: {load.assignedDriverName ?? 'Unassigned'}
                        </div>
                        <div
                          className={`kanban-card-date ${urgent ? 'kanban-card-date-urgent' : ''}`}
                        >
                          {formatDateShort(date)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {assigningCarrierFor ? (
        <AssignCarrierModal
          open
          loadId={assigningCarrierFor}
          onClose={() => setAssigningCarrierFor(null)}
          onAssigned={() => {
            setAssigningCarrierFor(null);
            onChanged();
          }}
        />
      ) : null}
      {generatingRateConfFor ? (
        <GenerateRateConfirmationModal
          open
          loadId={generatingRateConfFor}
          onClose={() => setGeneratingRateConfFor(null)}
          onGenerated={() => {
            setGeneratingRateConfFor(null);
            onChanged();
          }}
        />
      ) : null}
      {dispatchingFor ? (
        <DispatchModal
          open
          loadId={dispatchingFor.id}
          carrierId={dispatchingFor.assignedCarrierId}
          onClose={() => setDispatchingFor(null)}
          onDispatched={() => {
            setDispatchingFor(null);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={rejectingFor !== null}
        title="Carrier Rejected"
        message="This records the carrier's rejection after assignment and returns the load to Carrier Sourcing."
        confirmLabel="Record Rejection"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setRejectingFor(null)}
        onConfirm={onCarrierRejected}
      />
    </>
  );
}
