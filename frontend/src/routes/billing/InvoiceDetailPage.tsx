import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import {
  billingApi,
  customersApi,
  documentsApi,
  type AddAdjustmentRequest,
  type AppDocument,
  type RecordPaymentRequest,
  type SendInvoiceRequest,
} from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
  CurrencyInput,
  DataTable,
  DatePicker,
  Modal,
  ModalFooter,
  QueryErrorState,
  Select,
  Textarea,
  TextField,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/DetailPage.css';

const ADJUSTMENT_TYPE_OPTIONS = [
  { value: 'CREDIT', label: 'Credit' },
  { value: 'DEBIT', label: 'Debit' },
];

/** UI_UX_DESIGN.md §5.4.7b Invoice Detail — status-driven header primary action. */
export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [addingAdjustment, setAddingAdjustment] = useState(false);
  const [voiding, setVoiding] = useState(false);
  // Approved decision 4: after Send succeeds, poll for the async-generated
  // PDF's readiness (documentsApi.waitForDocumentReady) rather than
  // exposing any backend readiness endpoint.
  const [pdfStatus, setPdfStatus] = useState<
    'idle' | 'generating' | 'ready' | 'failed' | 'timeout'
  >('idle');
  const [pdfDocument, setPdfDocument] = useState<AppDocument | null>(null);

  const {
    data: invoice,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['invoices', id],
    queryFn: () => billingApi.getInvoiceById(id),
    enabled: Boolean(id),
  });
  const { data: customer } = useQuery({
    queryKey: ['customers', invoice?.customerId],
    queryFn: () => customersApi.getById(invoice!.customerId),
    enabled: Boolean(invoice?.customerId),
  });

  const sendForm = useForm<SendInvoiceRequest>();
  const paymentForm = useForm<RecordPaymentRequest>();
  const adjustmentForm = useForm<AddAdjustmentRequest>({ defaultValues: { type: 'CREDIT' } });

  const canManageInvoice = can('sendOrVoidInvoice');
  const canRecordPayment = can('recordPaymentOrAdjustment');

  async function refetchAll() {
    await refetch();
  }

  async function onSend(values: SendInvoiceRequest) {
    try {
      await billingApi.sendInvoice(id, values);
      toast.success('Invoice sent.');
      setSending(false);
      refetchAll();
      setPdfStatus('generating');
      const doc = await documentsApi.waitForDocumentReady('INVOICE', id);
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

  async function onRecordPayment(values: RecordPaymentRequest) {
    try {
      await billingApi.recordPayment(id, values);
      toast.success('Payment recorded.');
      setRecordingPayment(false);
      paymentForm.reset();
      refetchAll();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onAddAdjustment(values: AddAdjustmentRequest) {
    try {
      await billingApi.addAdjustment(id, {
        ...values,
        adjustmentDate: values.adjustmentDate || undefined,
      });
      toast.success('Adjustment added.');
      setAddingAdjustment(false);
      adjustmentForm.reset({ type: 'CREDIT' });
      refetchAll();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onVoid() {
    try {
      await billingApi.voidInvoice(id);
      toast.success('Invoice voided — its loads returned to the Ready-to-Invoice queue.');
      setVoiding(false);
      refetchAll();
      queryClient.invalidateQueries({ queryKey: ['loads', 'ready-to-invoice'] });
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (isLoading) {
    return <div>Loading…</div>;
  }

  if (isError || !invoice) {
    return (
      <QueryErrorState
        message="Couldn't load this invoice. Please try again."
        onRetry={() => refetch()}
      />
    );
  }

  const canSend = canManageInvoice && invoice.status === 'DRAFT';
  const canPay = canRecordPayment && ['SENT', 'PARTIALLY_PAID'].includes(invoice.status);
  const canAdjust = canRecordPayment && !['DRAFT', 'VOID'].includes(invoice.status);
  const canVoid = canManageInvoice && invoice.status !== 'VOID';

  return (
    <div>
      <Breadcrumb
        items={[{ label: 'Invoices', to: '/billing/invoices' }, { label: invoice.invoiceNumber }]}
      />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">{invoice.invoiceNumber}</h1>
          <Badge
            label={invoice.status}
            color={getStatusBadgeColor('Invoice.status', invoice.status) ?? 'neutral'}
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
          {canSend ? (
            <Button
              onClick={() => {
                sendForm.reset({
                  recipientEmail: customer?.primaryContactEmail ?? '',
                  subject: `Invoice ${invoice.invoiceNumber}`,
                  message: '',
                });
                setSending(true);
              }}
            >
              Send Invoice
            </Button>
          ) : null}
          {canPay ? (
            <Button
              onClick={() => {
                paymentForm.reset({ paymentDate: new Date().toISOString().slice(0, 10) });
                setRecordingPayment(true);
              }}
            >
              Record Payment
            </Button>
          ) : null}
          {canAdjust ? (
            <Button variant="secondary" onClick={() => setAddingAdjustment(true)}>
              Add Adjustment
            </Button>
          ) : null}
          {canVoid ? (
            <Button variant="destructive" onClick={() => setVoiding(true)}>
              Void
            </Button>
          ) : null}
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Invoice Info</h2>
        <div className="detail-card-grid">
          <Field label="Customer" value={customer?.legalName ?? invoice.customerId} />
          <Field label="Total" value={invoice.total != null ? `$${invoice.total}` : '—'} />
          <Field
            label="Remaining Balance"
            value={invoice.remainingBalance != null ? `$${invoice.remainingBalance}` : '—'}
          />
          <Field
            label="Due Date"
            value={invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : '—'}
          />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Line Items</h2>
        <DataTable
          rows={invoice.lineItems}
          rowKey={(li) => li.id}
          emptyMessage="No line items."
          columns={[
            { key: 'description', header: 'Description', render: (li) => li.description },
            { key: 'amount', header: 'Amount', render: (li) => `$${li.amount}` },
          ]}
        />
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Payments</h2>
        <DataTable
          rows={invoice.payments}
          rowKey={(p) => p.id}
          emptyMessage="No payments recorded yet."
          columns={[
            {
              key: 'date',
              header: 'Date',
              render: (p) => new Date(p.paymentDate).toLocaleDateString(),
            },
            { key: 'amount', header: 'Amount', render: (p) => `$${p.amount}` },
            { key: 'method', header: 'Method', render: (p) => p.method },
            { key: 'reference', header: 'Reference', render: (p) => p.referenceNumber || '—' },
          ]}
        />
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Adjustments</h2>
        <DataTable
          rows={invoice.adjustments}
          rowKey={(a) => a.id}
          emptyMessage="No adjustments yet."
          columns={[
            {
              key: 'date',
              header: 'Date',
              render: (a) => new Date(a.adjustmentDate).toLocaleDateString(),
            },
            {
              key: 'type',
              header: 'Type',
              render: (a) => <Badge label={a.type} color="neutral" />,
            },
            { key: 'amount', header: 'Amount', render: (a) => `$${a.amount}` },
            { key: 'reason', header: 'Reason', render: (a) => a.reason },
          ]}
        />
      </div>

      <Modal
        open={sending}
        title="Send Invoice"
        onClose={() => setSending(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setSending(false)}
            onConfirm={sendForm.handleSubmit(onSend)}
            confirmLabel="Send"
            loading={sendForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={sendForm.handleSubmit(onSend)}>
          <TextField
            label="Recipient Email"
            required
            type="email"
            {...sendForm.register('recipientEmail', { required: true })}
          />
          <TextField
            label="Subject"
            required
            {...sendForm.register('subject', { required: true })}
          />
          <Textarea
            label="Message"
            required
            rows={4}
            {...sendForm.register('message', { required: true })}
          />
        </form>
      </Modal>

      <Modal
        open={recordingPayment}
        title="Record Payment"
        onClose={() => setRecordingPayment(false)}
        footer={
          <ModalFooter
            onCancel={() => setRecordingPayment(false)}
            onConfirm={paymentForm.handleSubmit(onRecordPayment)}
            confirmLabel="Record Payment"
            loading={paymentForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={paymentForm.handleSubmit(onRecordPayment)}>
          <CurrencyInput
            label="Amount"
            required
            {...paymentForm.register('amount', { required: true })}
          />
          <DatePicker
            label="Payment Date"
            required
            {...paymentForm.register('paymentDate', { required: true })}
          />
          <TextField
            label="Method"
            required
            {...paymentForm.register('method', { required: true })}
          />
          <TextField label="Reference Number" {...paymentForm.register('referenceNumber')} />
          <Textarea label="Notes" {...paymentForm.register('notes')} rows={2} />
        </form>
      </Modal>

      <Modal
        open={addingAdjustment}
        title="Add Adjustment"
        onClose={() => setAddingAdjustment(false)}
        footer={
          <ModalFooter
            onCancel={() => setAddingAdjustment(false)}
            onConfirm={adjustmentForm.handleSubmit(onAddAdjustment)}
            confirmLabel="Add Adjustment"
            loading={adjustmentForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={adjustmentForm.handleSubmit(onAddAdjustment)}>
          <Select
            label="Type"
            options={ADJUSTMENT_TYPE_OPTIONS}
            {...adjustmentForm.register('type')}
          />
          <CurrencyInput
            label="Amount"
            required
            {...adjustmentForm.register('amount', { required: true })}
          />
          <TextField
            label="Reason"
            required
            {...adjustmentForm.register('reason', { required: true })}
          />
          <DatePicker label="Adjustment Date" {...adjustmentForm.register('adjustmentDate')} />
        </form>
      </Modal>

      <Modal
        open={voiding}
        title="Void Invoice"
        onClose={() => setVoiding(false)}
        footer={
          <ModalFooter
            onCancel={() => setVoiding(false)}
            onConfirm={onVoid}
            confirmLabel="Void Invoice"
            confirmVariant="destructive"
          />
        }
      >
        <p>
          Voiding this invoice will release its {invoice.invoiceLoads.length} load(s) back to the
          Ready-to-Invoice queue.
        </p>
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
