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
import { FinancialsTab } from './tabs/FinancialsTab';
import { ActivityHistoryTab } from './tabs/ActivityHistoryTab';
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
 * UI_UX_DESIGN.md §5.4.4 Load Detail. Phase 3 shipped Overview, Stops &
 * Tracking, Carrier & Dispatch, Documents; Phase 4 adds the Financials
 * tab (hidden entirely for Dispatcher) and the Overview tab's Closing
 * Readiness card (linking out to the dedicated Load Closing screen,
 * §5.4.8). Frontend Phase 7 adds the sixth tab, Activity History —
 * visible to every role (unlike Financials), matching the locked
 * "visible to all roles (subject to redaction)" rule. The header's
 * `DELIVERED`/`CLOSED`-state primary action intentionally stays absent —
 * Create Invoice/Close Load live in the Financials tab's Customer
 * Invoice card and the Closing Readiness card respectively, not
 * duplicated as a header button; this phase's plan scoped the header
 * itself as unchanged.
 */
export function LoadDetailPage() {
  const { id = '' } = useParams();
  const { can, roles } = usePermissions();
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

  // Financials tab is fully hidden for Dispatcher, not just redacted
  // (locked, §5.4.4 — "consistent with §5.4.1's 'financial columns fully
  // absent' principle extended to a whole tab").
  const showFinancialsTab = !roles.includes('DISPATCHER');

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'stops', label: 'Stops & Tracking' },
    { key: 'carrier', label: 'Carrier & Dispatch' },
    { key: 'documents', label: 'Documents' },
    ...(showFinancialsTab ? [{ key: 'financials', label: 'Financials' }] : []),
    { key: 'activity', label: 'Activity History' },
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

      {activeTab === 'overview' ? <OverviewTab load={load} onChanged={refetch} /> : null}
      {activeTab === 'stops' ? <StopsTrackingTab load={load} onChanged={refetch} /> : null}
      {activeTab === 'carrier' ? <CarrierDispatchTab load={load} onChanged={refetch} /> : null}
      {activeTab === 'documents' ? <DocumentsTab load={load} /> : null}
      {activeTab === 'financials' && showFinancialsTab ? (
        <FinancialsTab load={load} onChanged={refetch} />
      ) : null}
      {activeTab === 'activity' ? <ActivityHistoryTab load={load} /> : null}

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
