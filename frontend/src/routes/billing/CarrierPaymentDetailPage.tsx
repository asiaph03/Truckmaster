import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  carrierPayApi,
  carriersApi,
  documentsApi,
  loadsApi,
  type AppDocument,
  type MarkPaidRequest,
} from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
  ConfirmDialog,
  DatePicker,
  Modal,
  ModalFooter,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { useSessionStore } from '../../auth/session-store';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/DetailPage.css';

/**
 * The Approve/Reject reviewer UI has no locked design (acknowledged
 * prototype gap — "stops at Pending Approval on submission, the
 * Approve/Reject step itself isn't wired into a separate reviewer
 * action"). Built here using the same status-driven-action + sectioned-
 * card convention as Invoice/Quote Detail, and `ConfirmDialog` with a
 * required reason for Reject (matching Carrier compliance-document
 * rejection's own precedent). Self-review is disabled client-side with
 * a tooltip as a UX nicety — the backend's 403 `SELF_REVIEW_FORBIDDEN`
 * remains the actual enforcement.
 */
export function CarrierPaymentDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const userId = useSessionStore((s) => s.userId);
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [paymentDate, setPaymentDate] = useState('');
  // Approved decision 4: after Mark Paid succeeds, poll for the
  // async-generated settlement PDF's readiness rather than exposing any
  // backend readiness endpoint.
  const [pdfStatus, setPdfStatus] = useState<
    'idle' | 'generating' | 'ready' | 'failed' | 'timeout'
  >('idle');
  const [pdfDocument, setPdfDocument] = useState<AppDocument | null>(null);

  const {
    data: payment,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['carrier-payments', id],
    queryFn: () => carrierPayApi.getById(id),
    enabled: Boolean(id),
  });
  const { data: carrier } = useQuery({
    queryKey: ['carriers', payment?.carrierId],
    queryFn: () => carriersApi.getById(payment!.carrierId),
    enabled: Boolean(payment?.carrierId),
  });
  const { data: load } = useQuery({
    queryKey: ['loads', payment?.loadId],
    queryFn: () => loadsApi.getById(payment!.loadId),
    enabled: Boolean(payment?.loadId),
  });

  const canPrepareSubmit = can('createOrSubmitCarrierPayment');
  const canApproveReject = can('approveOrRejectCarrierPayment');

  async function onSubmit() {
    try {
      await carrierPayApi.submit(id);
      toast.success('Submitted for approval.');
      refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onApprove() {
    try {
      await carrierPayApi.approve(id);
      toast.success('Approved.');
      refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onReject(reason?: string) {
    try {
      await carrierPayApi.reject(id, { reason: reason ?? '' });
      toast.success('Rejected — returned to Draft.');
      setRejecting(false);
      refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onMarkPaid() {
    try {
      const body: MarkPaidRequest = paymentDate ? { paymentDate } : {};
      await carrierPayApi.markPaid(id, body);
      toast.success('Marked Paid.');
      setMarkingPaid(false);
      refetch();
      setPdfStatus('generating');
      const doc = await documentsApi.waitForDocumentReady('CARRIER_PAYMENT', id);
      setPdfStatus(doc?.generationStatus === 'FAILED' ? 'failed' : doc ? 'ready' : 'timeout');
      setPdfDocument(doc);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onDownloadPdf() {
    if (!pdfDocument) return;
    try {
      const { url } = await documentsApi.getDownloadUrl(pdfDocument.id);
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.danger('Could not get a download link.');
    }
  }

  if (isLoading || !payment) {
    return <div>Loading…</div>;
  }

  const isOwnPreparation = payment.preparedByUserId === userId;
  const canSubmit =
    canPrepareSubmit && payment.status === 'DRAFT' && payment.method && payment.referenceNumber;
  const canReview = canApproveReject && payment.status === 'PENDING_APPROVAL';
  const canMarkPaid = canPrepareSubmit && payment.status === 'APPROVED';

  return (
    <div>
      <Breadcrumb
        items={[
          { label: 'Carrier Payments', to: '/billing/carrier-pay' },
          { label: payment.paymentType },
        ]}
      />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">
            {payment.paymentType} — ${payment.amount}
          </h1>
          <Badge
            label={payment.status.replace('_', ' ')}
            color={getStatusBadgeColor('CarrierPayment.status', payment.status) ?? 'neutral'}
          />
          {pdfStatus === 'generating' ? (
            <Badge label="Generating PDF…" color="neutral" />
          ) : pdfStatus === 'failed' ? (
            <Badge
              label="Generation Failed"
              color={getStatusBadgeColor('Document.generationStatus', 'FAILED') ?? 'danger'}
            />
          ) : pdfStatus === 'ready' ? (
            <Button variant="tertiary" size="sm" onClick={onDownloadPdf}>
              Download PDF
            </Button>
          ) : null}
        </div>
        <div className="detail-page-actions">
          {canSubmit ? <Button onClick={onSubmit}>Submit for Approval</Button> : null}
          {canReview ? (
            <>
              <Button
                disabled={isOwnPreparation}
                title={isOwnPreparation ? 'You cannot approve a payment you prepared.' : undefined}
                onClick={onApprove}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                disabled={isOwnPreparation}
                title={isOwnPreparation ? 'You cannot reject a payment you prepared.' : undefined}
                onClick={() => setRejecting(true)}
              >
                Reject
              </Button>
            </>
          ) : null}
          {canMarkPaid ? (
            <Button
              onClick={() => {
                setPaymentDate(new Date().toISOString().slice(0, 10));
                setMarkingPaid(true);
              }}
            >
              Mark Paid
            </Button>
          ) : null}
        </div>
      </div>

      {payment.status === 'DRAFT' && payment.lastRejectionReason ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          <h2 className="detail-card-title">Last Rejection</h2>
          <p style={{ margin: 0 }}>{payment.lastRejectionReason}</p>
        </div>
      ) : null}

      <div className="detail-card">
        <h2 className="detail-card-title">Payment Info</h2>
        <div className="detail-card-grid">
          <Field label="Carrier" value={carrier?.legalName ?? payment.carrierId} />
          <Field label="Load" value={load?.loadNumber ?? payment.loadId} />
          <Field label="Type" value={payment.paymentType} />
          <Field label="Amount" value={`$${payment.amount}`} />
          <Field label="Method" value={payment.method || '—'} />
          <Field label="Reference Number" value={payment.referenceNumber || '—'} />
          <Field label="Notes" value={payment.notes || '—'} />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">History</h2>
        <div className="detail-card-grid">
          <Field
            label="Submitted"
            value={payment.submittedAt ? new Date(payment.submittedAt).toLocaleString() : '—'}
          />
          <Field
            label="Approved"
            value={payment.approvedAt ? new Date(payment.approvedAt).toLocaleString() : '—'}
          />
          <Field
            label="Paid"
            value={payment.paidAt ? new Date(payment.paidAt).toLocaleString() : '—'}
          />
        </div>
      </div>

      <ConfirmDialog
        open={rejecting}
        title="Reject Carrier Payment"
        message="This returns the payment to Draft so it can be revised and resubmitted."
        confirmLabel="Reject"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setRejecting(false)}
        onConfirm={onReject}
      />

      <Modal
        open={markingPaid}
        title="Mark Paid"
        onClose={() => setMarkingPaid(false)}
        footer={
          <ModalFooter
            onCancel={() => setMarkingPaid(false)}
            onConfirm={onMarkPaid}
            confirmLabel="Mark Paid"
          />
        }
      >
        <DatePicker
          label="Payment Date"
          value={paymentDate}
          onChange={(e) => setPaymentDate(e.target.value)}
        />
      </Modal>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{value}</div>
    </div>
  );
}
