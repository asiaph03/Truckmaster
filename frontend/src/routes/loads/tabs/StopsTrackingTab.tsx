import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { loadsApi, type Load, type LogCheckCallRequest, type RiskStatus } from '../../../api';
import { ApiError } from '../../../api/errors';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import {
  Badge,
  Button,
  DataTable,
  DatePicker,
  Modal,
  ModalFooter,
  Select,
  Textarea,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatBusinessDateTime } from '../businessTimezone';
import { InitiateReturnModal } from '../modals/InitiateReturnModal';
import '../../shared/DetailPage.css';

const RISK_OPTIONS: { value: RiskStatus; label: string }[] = [
  { value: 'NORMAL', label: 'Normal' },
  { value: 'AT_RISK', label: 'At Risk' },
  { value: 'DELAYED', label: 'Delayed' },
];

const ON_TIME_OPTIONS = [
  { value: 'ON_TIME', label: 'On Time' },
  { value: 'LATE', label: 'Late' },
  { value: 'UNKNOWN', label: 'Unknown' },
];

/**
 * UI_UX_DESIGN.md §5.4.4 Stops & Tracking tab. Check Calls and Risk
 * Status are status-gated (`DISPATCHED`/`PICKUP`/`IN_TRANSIT` only) —
 * shown disabled-with-tooltip rather than hidden, per the locked
 * distinction between status-gating and permission-gating. Recording
 * arrival/departure has no such status gate (a load only reaches this
 * tab with recordable stops once `DISPATCHED`, so the action buttons
 * are simply absent once a stop is `COMPLETED`).
 */
export function StopsTrackingTab({ load, onChanged }: { load: Load; onChanged: () => void }) {
  const { can } = usePermissions();
  const toast = useToast();
  const canAct = can('sourceAndDispatchLoads');
  const trackingEnabled = (['DISPATCHED', 'PICKUP', 'IN_TRANSIT'] as string[]).includes(
    load.status,
  );
  // Return Product feature — matches DispatchTrackingService.initiateReturn's
  // own gate exactly: anything from DISPATCHED through DELIVERED, never
  // CLOSED or pre-DISPATCHED.
  const canInitiateReturn = trackingEnabled || load.status === 'DELIVERED';
  const [recordingStopSeq, setRecordingStopSeq] = useState<number | null>(null);
  const [loggingCheckCall, setLoggingCheckCall] = useState(false);
  const [initiatingReturn, setInitiatingReturn] = useState(false);
  const [pendingRisk, setPendingRisk] = useState<RiskStatus | null>(null);
  const [riskReason, setRiskReason] = useState('');
  const [savingRisk, setSavingRisk] = useState(false);

  const sortedStops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const sortedCheckCalls = [...load.checkCalls].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  async function recordStop(sequence: number, kind: 'arrival' | 'departure') {
    setRecordingStopSeq(sequence);
    try {
      if (kind === 'arrival') await loadsApi.recordStopArrival(load.id, sequence);
      else await loadsApi.recordStopDeparture(load.id, sequence);
      toast.success(`${kind === 'arrival' ? 'Arrival' : 'Departure'} recorded — Stop ${sequence}.`);
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setRecordingStopSeq(null);
    }
  }

  async function saveRiskStatus() {
    if (!pendingRisk) return;
    setSavingRisk(true);
    try {
      await loadsApi.setRiskStatus(load.id, {
        riskStatus: pendingRisk,
        riskReason: pendingRisk === 'NORMAL' ? undefined : riskReason,
      });
      toast.success('Risk status updated.');
      setPendingRisk(null);
      setRiskReason('');
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSavingRisk(false);
    }
  }

  const checkCallForm = useForm<LogCheckCallRequest>({
    defaultValues: { onTimeStatus: 'UNKNOWN' },
  });

  async function onLogCheckCall(values: LogCheckCallRequest) {
    try {
      // `occurredAt`/`eta` are optional `@IsDateString()` fields on the
      // backend — `@IsOptional()` there only skips validation for
      // undefined/null, not '', so an untouched datetime-local input
      // (which submits '') gets rejected as "not a valid ISO 8601 date
      // string" unless stripped to undefined here.
      await loadsApi.logCheckCall(load.id, {
        ...values,
        occurredAt: values.occurredAt || undefined,
        eta: values.eta || undefined,
      });
      toast.success('Check call logged.');
      checkCallForm.reset({ onTimeStatus: 'UNKNOWN' });
      setLoggingCheckCall(false);
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Stops
        </h2>
        {canAct ? (
          <Button
            variant="tertiary"
            size="sm"
            disabled={!canInitiateReturn}
            title={
              !canInitiateReturn
                ? 'Available once the load is Dispatched, until it is Closed.'
                : undefined
            }
            onClick={() => setInitiatingReturn(true)}
          >
            + Initiate Return
          </Button>
        ) : null}
      </div>
      <DataTable
        rows={sortedStops}
        rowKey={(s) => s.id}
        columns={[
          { key: 'seq', header: 'Seq', render: (s) => s.sequence },
          {
            key: 'type',
            header: 'Type',
            render: (s) => (
              <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                <Badge label={s.stopType} color="neutral" />
                {s.stopPurpose === 'RETURN' ? <Badge label="Return" color="warning" /> : null}
              </div>
            ),
          },
          {
            key: 'location',
            header: 'Location',
            render: (s) => `${s.companyName ?? '—'} — ${s.city}, ${s.state} ${s.zip}`,
          },
          {
            key: 'scheduled',
            header: 'Scheduled',
            render: (s) => formatBusinessDateTime(s.appointmentDatetime ?? null),
          },
          {
            key: 'arrival',
            header: 'Actual Arrival',
            render: (s) =>
              s.actualArrival ? (
                formatBusinessDateTime(s.actualArrival)
              ) : canAct && s.status === 'PENDING' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={recordingStopSeq === s.sequence}
                  onClick={() => recordStop(s.sequence, 'arrival')}
                >
                  Record Arrival
                </Button>
              ) : (
                '—'
              ),
          },
          {
            key: 'departure',
            header: 'Actual Departure',
            render: (s) =>
              s.actualDeparture ? (
                formatBusinessDateTime(s.actualDeparture)
              ) : canAct && s.status === 'ARRIVED' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={recordingStopSeq === s.sequence}
                  onClick={() => recordStop(s.sequence, 'departure')}
                >
                  Record Departure
                </Button>
              ) : (
                '—'
              ),
          },
          {
            key: 'status',
            header: 'Status',
            render: (s) => (
              <Badge
                label={s.status}
                color={getStatusBadgeColor('Stop.status', s.status) ?? 'neutral'}
              />
            ),
          },
        ]}
      />

      <div className="detail-card" style={{ marginTop: 'var(--space-4)' }}>
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            Check Calls
          </h2>
          {canAct ? (
            <Button
              variant="tertiary"
              size="sm"
              disabled={!trackingEnabled}
              title={!trackingEnabled ? 'Available once the load is Dispatched.' : undefined}
              onClick={() => setLoggingCheckCall(true)}
            >
              + Log Check Call
            </Button>
          ) : null}
        </div>
        {sortedCheckCalls.length === 0 ? (
          <span className="detail-field-value">No check calls logged yet.</span>
        ) : (
          sortedCheckCalls.map((cc) => (
            <div key={cc.id} className="load-stop-mini-row">
              <span className="load-stop-mini-time">{formatBusinessDateTime(cc.occurredAt)}</span>
              <span>{cc.contactMethod}</span>
              <span className="load-stop-mini-location">{cc.personContacted}</span>
              <span className="load-stop-mini-location">
                {[cc.locationCity, cc.locationState].filter(Boolean).join(', ') || '—'}
              </span>
              <Badge
                label={cc.onTimeStatus.replace('_', ' ')}
                color={cc.onTimeStatus === 'LATE' ? 'warning' : 'neutral'}
              />
            </div>
          ))
        )}
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Risk Status</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          {RISK_OPTIONS.map((opt) => {
            const active = (pendingRisk ?? load.riskStatus) === opt.value;
            return (
              <Button
                key={opt.value}
                size="sm"
                variant={active ? 'primary' : 'secondary'}
                disabled={!canAct || !trackingEnabled}
                title={!trackingEnabled ? 'Available once the load is Dispatched.' : undefined}
                onClick={() => setPendingRisk(opt.value)}
              >
                {opt.label}
              </Button>
            );
          })}
        </div>
        {pendingRisk && pendingRisk !== 'NORMAL' ? (
          <Textarea
            label="Reason"
            required
            value={riskReason}
            onChange={(e) => setRiskReason(e.target.value)}
            rows={2}
          />
        ) : null}
        {pendingRisk && pendingRisk !== load.riskStatus ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button
              size="sm"
              loading={savingRisk}
              disabled={pendingRisk !== 'NORMAL' && riskReason.trim().length === 0}
              onClick={saveRiskStatus}
            >
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPendingRisk(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>

      <Modal
        open={loggingCheckCall}
        title="Log Check Call"
        onClose={() => setLoggingCheckCall(false)}
        footer={
          <ModalFooter
            onCancel={() => setLoggingCheckCall(false)}
            onConfirm={checkCallForm.handleSubmit(onLogCheckCall)}
            confirmLabel="Log Check Call"
            loading={checkCallForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={checkCallForm.handleSubmit(onLogCheckCall)}>
          <DatePicker label="Occurred At" withTime {...checkCallForm.register('occurredAt')} />
          <TextField
            label="Contact Method"
            required
            {...checkCallForm.register('contactMethod', { required: true })}
          />
          <TextField
            label="Person Contacted"
            required
            {...checkCallForm.register('personContacted', { required: true })}
          />
          <div className="detail-card-grid">
            <TextField label="Location City" {...checkCallForm.register('locationCity')} />
            <TextField label="Location State" {...checkCallForm.register('locationState')} />
          </div>
          <DatePicker label="ETA" withTime {...checkCallForm.register('eta')} />
          <Select
            label="On-Time Status"
            options={ON_TIME_OPTIONS}
            {...checkCallForm.register('onTimeStatus')}
          />
          <Textarea label="Notes" {...checkCallForm.register('notes')} rows={2} />
        </form>
      </Modal>

      <InitiateReturnModal
        open={initiatingReturn}
        loadId={load.id}
        onClose={() => setInitiatingReturn(false)}
        onInitiated={() => {
          setInitiatingReturn(false);
          onChanged();
        }}
      />
    </div>
  );
}
