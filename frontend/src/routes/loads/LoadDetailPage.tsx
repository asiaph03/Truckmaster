import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadsApi } from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { Badge, Breadcrumb, Button, Stepper, Tabs } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import { AssignCarrierModal } from './modals/AssignCarrierModal';
import { DispatchModal } from './modals/DispatchModal';
import { GenerateRateConfirmationModal } from './modals/GenerateRateConfirmationModal';
import { OverviewTab } from './tabs/OverviewTab';
import { StopsTrackingTab } from './tabs/StopsTrackingTab';
import { CarrierDispatchTab } from './tabs/CarrierDispatchTab';
import { DocumentsTab } from './tabs/DocumentsTab';
import '../shared/DetailPage.css';
import './LoadDetailPage.css';

const STEPS = [
  { key: 'BOOKED', label: 'Booked' },
  { key: 'CARRIER_SOURCING', label: 'Sourcing' },
  { key: 'CARRIER_ASSIGNED', label: 'Assigned' },
  { key: 'RATE_CONFIRMATION', label: 'Rate Conf' },
  { key: 'DISPATCHED', label: 'Dispatched' },
  { key: 'PICKUP', label: 'Pickup' },
  { key: 'IN_TRANSIT', label: 'Transit' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'CLOSED', label: 'Closed' },
];

const TRACKING_STATUSES = ['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as const;

/**
 * UI_UX_DESIGN.md §5.4.4 Load Detail. Ships the 4 tabs approved for this
 * phase (Overview, Stops & Tracking, Carrier & Dispatch, Documents) —
 * Financials, Activity History, and the Load Closing screen remain
 * deferred (approved Phase 3 plan §7 decision 2), so the header's
 * `DELIVERED`/`CLOSED`-state primary actions (Create Invoice, Close
 * Load) are not rendered: no invented invoicing/closing behavior, just
 * an absent button for the statuses whose actions live in deferred
 * screens.
 */
export function LoadDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  const [assigningCarrier, setAssigningCarrier] = useState(false);
  const [generatingRateConfirmation, setGeneratingRateConfirmation] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [beginningSourcing, setBeginningSourcing] = useState(false);
  const [recordingStop, setRecordingStop] = useState(false);

  const { data: load, isLoading } = useQuery({
    queryKey: ['loads', id],
    queryFn: () => loadsApi.getById(id),
    enabled: Boolean(id),
  });

  async function refetch() {
    await queryClient.invalidateQueries({ queryKey: ['loads', id] });
  }

  const canAct = can('sourceAndDispatchLoads');

  if (isLoading || !load) {
    return <div>Loading…</div>;
  }

  async function onBeginSourcing() {
    setBeginningSourcing(true);
    try {
      await loadsApi.beginSourcing(load!.id);
      toast.success('Sourcing started.');
      await refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setBeginningSourcing(false);
    }
  }

  const nextStop = [...load.stops]
    .sort((a, b) => a.sequence - b.sequence)
    .find((s) => s.status !== 'COMPLETED');

  async function onRecordStopAction() {
    if (!nextStop) return;
    setRecordingStop(true);
    try {
      if (nextStop.status === 'PENDING') {
        await loadsApi.recordStopArrival(load!.id, nextStop.sequence);
        toast.success(`Arrival recorded — Stop ${nextStop.sequence}.`);
      } else {
        await loadsApi.recordStopDeparture(load!.id, nextStop.sequence);
        toast.success(`Departure recorded — Stop ${nextStop.sequence}.`);
      }
      await refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setRecordingStop(false);
    }
  }

  const stepIndex = Math.max(
    0,
    STEPS.findIndex((s) => s.key === load.status),
  );

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'stops', label: 'Stops & Tracking' },
    { key: 'carrier', label: 'Carrier & Dispatch' },
    { key: 'documents', label: 'Documents' },
  ];

  return (
    <div>
      <Breadcrumb items={[{ label: 'Loads', to: '/loads/board' }, { label: load.loadNumber }]} />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">{load.loadNumber}</h1>
          <Badge
            label={load.status}
            color={getStatusBadgeColor('Load.status', load.status) ?? 'neutral'}
          />
          {load.riskStatus !== 'NORMAL' ? (
            <Badge
              label={`Risk: ${load.riskStatus}`}
              color={getStatusBadgeColor('Load.riskStatus', load.riskStatus) ?? 'warning'}
            />
          ) : null}
          <Badge
            label={`POD: ${load.podStatus}`}
            color={getStatusBadgeColor('Load.podStatus', load.podStatus) ?? 'neutral'}
          />
        </div>
        {canAct ? (
          <div className="detail-page-actions">
            {load.status === 'BOOKED' ? (
              <Button loading={beginningSourcing} onClick={onBeginSourcing}>
                Begin Carrier Sourcing
              </Button>
            ) : null}
            {load.status === 'CARRIER_SOURCING' ? (
              <Button onClick={() => setAssigningCarrier(true)}>Assign Carrier</Button>
            ) : null}
            {load.status === 'CARRIER_ASSIGNED' ? (
              <Button onClick={() => setGeneratingRateConfirmation(true)}>
                Generate Rate Confirmation
              </Button>
            ) : null}
            {load.status === 'RATE_CONFIRMATION' ? (
              <Button onClick={() => setDispatching(true)}>Dispatch Load</Button>
            ) : null}
            {(TRACKING_STATUSES as readonly string[]).includes(load.status) && nextStop ? (
              <Button loading={recordingStop} onClick={onRecordStopAction}>
                {nextStop.status === 'PENDING' ? 'Record Arrival' : 'Record Departure'} — Stop{' '}
                {nextStop.sequence}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="load-detail-stepper">
        <Stepper steps={STEPS} currentIndex={stepIndex} />
      </div>

      <div className="detail-page-tabs">
        <Tabs tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'overview' ? <OverviewTab load={load} /> : null}
      {activeTab === 'stops' ? <StopsTrackingTab load={load} onChanged={refetch} /> : null}
      {activeTab === 'carrier' ? <CarrierDispatchTab load={load} onChanged={refetch} /> : null}
      {activeTab === 'documents' ? <DocumentsTab load={load} /> : null}

      <AssignCarrierModal
        open={assigningCarrier}
        loadId={load.id}
        onClose={() => setAssigningCarrier(false)}
        onAssigned={() => {
          setAssigningCarrier(false);
          refetch();
        }}
      />
      <GenerateRateConfirmationModal
        open={generatingRateConfirmation}
        loadId={load.id}
        onClose={() => setGeneratingRateConfirmation(false)}
        onGenerated={() => {
          setGeneratingRateConfirmation(false);
          refetch();
        }}
      />
      <DispatchModal
        open={dispatching}
        loadId={load.id}
        carrierId={load.assignedCarrierId}
        onClose={() => setDispatching(false)}
        onDispatched={() => {
          setDispatching(false);
          refetch();
        }}
      />
    </div>
  );
}
