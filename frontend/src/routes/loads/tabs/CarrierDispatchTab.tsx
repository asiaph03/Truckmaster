import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  carriersApi,
  documentTypesApi,
  documentsApi,
  loadsApi,
  membershipsApi,
  type Load,
} from '../../../api';
import { ApiError } from '../../../api/errors';
import { Badge, Button, ConfirmDialog, DataTable } from '../../../components/ui';
import { getStatusBadgeColor } from '../../../components/ui/statusBadgeMap';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';
import { formatDateShort } from '../loadDerived';
import { DispatchModal } from '../modals/DispatchModal';
import { GenerateRateConfirmationModal } from '../modals/GenerateRateConfirmationModal';
import { LogSourcingAttemptModal } from '../modals/LogSourcingAttemptModal';
import { SendDriverDispatchEmailModal } from '../modals/SendDriverDispatchEmailModal';
import '../../shared/DetailPage.css';

/** UI_UX_DESIGN.md §5.4.4 Carrier & Dispatch tab. */
export function CarrierDispatchTab({ load, onChanged }: { load: Load; onChanged: () => void }) {
  const { can } = usePermissions();
  const toast = useToast();
  const canAct = can('sourceAndDispatchLoads');

  const [loggingAttempt, setLoggingAttempt] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [generatingRateConfirmation, setGeneratingRateConfirmation] = useState(false);
  const [editingDispatch, setEditingDispatch] = useState(false);
  const [sendingDriverDispatchEmail, setSendingDriverDispatchEmail] = useState(false);

  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers', {}],
    queryFn: () => carriersApi.list(),
  });
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
  });
  const { data: loadDocTypes = [] } = useQuery({
    queryKey: ['document-types', 'LOAD'],
    queryFn: () => documentTypesApi.list('LOAD'),
  });
  const { data: loadDocuments = [], refetch: refetchDocuments } = useQuery({
    queryKey: ['documents', 'LOAD', load.id],
    queryFn: () => documentsApi.list('LOAD', load.id),
  });

  const carrierName = (id?: string) => carriers.find((c) => c.id === id)?.legalName ?? id ?? '—';
  const userName = (id: string) => memberships.find((m) => m.userId === id)?.user.name ?? id;

  const rateConfType = loadDocTypes.find((t) => t.code === 'RATE_CONFIRMATION');
  const rateConfDoc = loadDocuments.find(
    (d) => d.documentTypeId === rateConfType?.id && d.isCurrentVersion,
  );

  const assignedAttempt = [...load.sourcingAttempts]
    .filter((a) => a.outcome === 'ASSIGNED' && a.carrierId === load.assignedCarrierId)
    .sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime())[0];

  async function onCarrierRejected(reason?: string) {
    setRejectSubmitting(true);
    try {
      await loadsApi.carrierRejected(load.id, { reason: reason ?? '' });
      toast.success('Carrier rejection recorded.');
      setRejecting(false);
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setRejectSubmitting(false);
    }
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Carrier Sourcing Attempts
        </h2>
        {canAct ? (
          <Button variant="tertiary" size="sm" onClick={() => setLoggingAttempt(true)}>
            + Log Attempt
          </Button>
        ) : null}
      </div>
      <DataTable
        rows={[...load.sourcingAttempts].sort(
          (a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime(),
        )}
        rowKey={(a) => a.id}
        emptyMessage="No sourcing attempts logged yet."
        columns={[
          { key: 'carrier', header: 'Carrier', render: (a) => carrierName(a.carrierId) },
          {
            key: 'rate',
            header: 'Rate Quoted',
            render: (a) => (a.carrierRate != null ? `$${a.carrierRate}` : '—'),
          },
          {
            key: 'outcome',
            header: 'Outcome',
            render: (a) => <Badge label={a.outcome.replace(/_/g, ' ')} color="neutral" />,
          },
          { key: 'reason', header: 'Reason', render: (a) => a.rejectionReason || '—' },
          { key: 'loggedBy', header: 'Logged By', render: (a) => userName(a.loggedByUserId) },
          { key: 'loggedAt', header: 'Logged At', render: (a) => formatDateShort(a.loggedAt) },
        ]}
      />

      {load.assignedCarrierId ? (
        <div className="detail-card" style={{ marginTop: 'var(--space-4)' }}>
          <h2 className="detail-card-title">Current Assignment</h2>
          <div className="detail-card-grid">
            <div>
              <div className="detail-field-label">Carrier</div>
              <div className="detail-field-value">
                <Link to={`/carriers/${load.assignedCarrierId}`}>
                  {carrierName(load.assignedCarrierId)}
                </Link>
              </div>
            </div>
            <div>
              <div className="detail-field-label">Carrier Rate</div>
              <div className="detail-field-value">
                {load.carrierRate != null ? `$${load.carrierRate}` : '—'}
              </div>
            </div>
            <div>
              <div className="detail-field-label">Assigned</div>
              <div className="detail-field-value">
                {assignedAttempt ? formatDateShort(assignedAttempt.loggedAt) : '—'}
              </div>
            </div>
          </div>
          {canAct && load.status === 'CARRIER_ASSIGNED' ? (
            <Button
              variant="destructive"
              size="sm"
              style={{ marginTop: 'var(--space-3)' }}
              onClick={() => setRejecting(true)}
            >
              Carrier Rejected
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="detail-card">
        <h2 className="detail-card-title">Rate Confirmation</h2>
        {rateConfDoc ? (
          rateConfDoc.generationStatus === 'PENDING' ? (
            <Badge label="Generating…" color="neutral" />
          ) : rateConfDoc.generationStatus === 'FAILED' ? (
            <Badge
              label="Generation Failed"
              color={getStatusBadgeColor('Document.generationStatus', 'FAILED') ?? 'danger'}
            />
          ) : (
            <p style={{ margin: 0 }}>
              {rateConfDoc.fileName} (v{rateConfDoc.versionNumber}) — uploaded{' '}
              {formatDateShort(rateConfDoc.uploadedAt)}
            </p>
          )
        ) : (
          <span className="detail-field-value">Not yet generated.</span>
        )}
        {canAct && load.assignedCarrierId && load.carrierRate != null && !rateConfDoc ? (
          <Button
            size="sm"
            style={{ marginTop: 'var(--space-3)' }}
            onClick={() => setGeneratingRateConfirmation(true)}
          >
            Generate Rate Confirmation
          </Button>
        ) : null}
      </div>

      <div className="detail-card">
        <div className="detail-section-header">
          <h2 className="detail-card-title" style={{ margin: 0 }}>
            Dispatch Record
          </h2>
          {canAct && load.dispatchRecord ? (
            <Button variant="tertiary" size="sm" onClick={() => setEditingDispatch(true)}>
              Edit
            </Button>
          ) : null}
        </div>
        {load.dispatchRecord ? (
          <div className="detail-card-grid">
            <div>
              <div className="detail-field-label">Driver</div>
              <div className="detail-field-value">
                {load.dispatchRecord.driverName} — {load.dispatchRecord.driverPhone}
              </div>
            </div>
            <div>
              <div className="detail-field-label">Truck</div>
              <div className="detail-field-value">{load.dispatchRecord.truckNumber}</div>
            </div>
            <div>
              <div className="detail-field-label">Trailer</div>
              <div className="detail-field-value">{load.dispatchRecord.trailerNumber}</div>
            </div>
            <div>
              <div className="detail-field-label">Dispatched</div>
              <div className="detail-field-value">
                {userName(load.dispatchRecord.dispatchedByUserId)} —{' '}
                {formatDateShort(load.dispatchRecord.dispatchedAt)}
              </div>
            </div>
          </div>
        ) : (
          <span className="detail-field-value">Not yet dispatched.</span>
        )}
        {canAct && load.dispatchRecord ? (
          <Button
            size="sm"
            style={{ marginTop: 'var(--space-3)' }}
            onClick={() => setSendingDriverDispatchEmail(true)}
          >
            Send Driver Dispatch Email
          </Button>
        ) : null}
      </div>

      <LogSourcingAttemptModal
        open={loggingAttempt}
        loadId={load.id}
        onClose={() => setLoggingAttempt(false)}
        onLogged={() => {
          setLoggingAttempt(false);
          onChanged();
        }}
      />
      <GenerateRateConfirmationModal
        open={generatingRateConfirmation}
        loadId={load.id}
        onClose={() => setGeneratingRateConfirmation(false)}
        onGenerated={() => {
          setGeneratingRateConfirmation(false);
          refetchDocuments();
          onChanged();
        }}
      />
      <DispatchModal
        open={editingDispatch}
        loadId={load.id}
        carrierId={load.assignedCarrierId}
        mode="edit"
        initialValues={
          load.dispatchRecord
            ? {
                driverName: load.dispatchRecord.driverName,
                driverPhone: load.dispatchRecord.driverPhone,
                truckNumber: load.dispatchRecord.truckNumber,
                trailerNumber: load.dispatchRecord.trailerNumber,
                sourceDriverId: load.dispatchRecord.sourceDriverId,
                sourceTruckId: load.dispatchRecord.sourceTruckId,
                sourceTrailerId: load.dispatchRecord.sourceTrailerId,
              }
            : undefined
        }
        onClose={() => setEditingDispatch(false)}
        onDispatched={() => {
          setEditingDispatch(false);
          onChanged();
        }}
      />
      <SendDriverDispatchEmailModal
        open={sendingDriverDispatchEmail}
        loadId={load.id}
        onClose={() => setSendingDriverDispatchEmail(false)}
        onSent={() => {
          setSendingDriverDispatchEmail(false);
          onChanged();
        }}
      />
      <ConfirmDialog
        open={rejecting}
        title="Carrier Rejected"
        message="This records the carrier's rejection after assignment and returns the load to Carrier Sourcing."
        confirmLabel="Record Rejection"
        confirmVariant="destructive"
        requireReason
        loading={rejectSubmitting}
        onCancel={() => setRejecting(false)}
        onConfirm={onCarrierRejected}
      />
    </div>
  );
}
