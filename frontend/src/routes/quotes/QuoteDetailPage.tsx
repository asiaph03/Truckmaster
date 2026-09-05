import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { customersApi, quotesApi, type MarkQuoteLostRequest } from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
  CurrencyInput,
  DataTable,
  Modal,
  ModalFooter,
  QueryErrorState,
  Textarea,
  Toggle,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import '../shared/DetailPage.css';

export function QuoteDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const toast = useToast();
  const [markingLost, setMarkingLost] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [inactiveOverride, setInactiveOverride] = useState(false);

  const {
    data: quote,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['quotes', id],
    queryFn: () => quotesApi.getById(id),
    enabled: Boolean(id),
  });

  const { data: customer } = useQuery({
    queryKey: ['customers', quote?.customerId],
    queryFn: () => customersApi.getById(quote!.customerId),
    enabled: Boolean(quote?.customerId),
  });

  const lostForm = useForm<MarkQuoteLostRequest>();
  const convertForm = useForm<{ confirmedCustomerRate: string }>();

  async function onMarkLost(values: MarkQuoteLostRequest) {
    await quotesApi.markLost(id, values);
    await refetch();
    toast.success('Quote marked as Lost.');
    setMarkingLost(false);
  }

  async function onConvert(values: { confirmedCustomerRate: string }) {
    setConvertError(null);
    try {
      const load = await quotesApi.convert(id, {
        confirmedCustomerRate: values.confirmedCustomerRate,
        confirmInactiveCustomerOverride:
          customer?.status === 'INACTIVE' ? inactiveOverride : undefined,
      });
      toast.success('Quote converted to a Load.');
      navigate(`/loads/${load.id}`);
    } catch (error) {
      setConvertError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (isLoading) {
    return <div>Loading…</div>;
  }

  if (isError || !quote) {
    return (
      <QueryErrorState
        message="Couldn't load this quote. Please try again."
        onRetry={() => refetch()}
      />
    );
  }

  const canAct = can('createQuoteOrLoad') && quote.status === 'OPEN';

  return (
    <div>
      <Breadcrumb items={[{ label: 'Quotes', to: '/quotes' }, { label: 'Quote' }]} />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">Quote</h1>
          <Badge
            label={quote.status}
            color={getStatusBadgeColor('Quote.status', quote.status) ?? 'neutral'}
          />
        </div>
        {canAct ? (
          <div className="detail-page-actions">
            <Button variant="destructive" onClick={() => setMarkingLost(true)}>
              Mark Lost
            </Button>
            <Button
              onClick={() => {
                convertForm.reset({ confirmedCustomerRate: quote.customerRate ?? '' });
                setConvertError(null);
                setConverting(true);
              }}
            >
              Convert to Load
            </Button>
          </div>
        ) : null}
      </div>

      {quote.status === 'LOST' && quote.lossReason ? (
        <div className="detail-card">
          <span className="detail-field-label">Loss Reason</span>
          <div className="detail-field-value">{quote.lossReason}</div>
        </div>
      ) : null}

      {quote.status === 'WON' && quote.resultingLoadId ? (
        <div className="detail-card">
          <Button variant="tertiary" onClick={() => navigate(`/loads/${quote.resultingLoadId}`)}>
            View resulting Load →
          </Button>
        </div>
      ) : null}

      <div className="detail-card">
        <h2 className="detail-card-title">Quote Info</h2>
        <div className="detail-card-grid">
          <Field label="Customer" value={customer?.legalName ?? quote.customerId} />
          <Field label="Equipment" value={quote.equipmentType.replace('_', ' ')} />
          <Field label="Rate" value={quote.customerRate != null ? `$${quote.customerRate}` : '—'} />
          <Field label="Rate Source" value={quote.rateSource ?? '—'} />
          <Field label="Expires" value={new Date(quote.expirationDate).toLocaleDateString()} />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Stops</h2>
        <DataTable
          rows={quote.stops}
          rowKey={(s) => String(s.sequence)}
          columns={[
            { key: 'seq', header: 'Seq', render: (s) => s.sequence },
            {
              key: 'type',
              header: 'Type',
              render: (s) => <Badge label={s.stopType} color="neutral" />,
            },
            {
              key: 'location',
              header: 'Location',
              render: (s) => `${s.addressCity}, ${s.addressState} ${s.addressZip}`,
            },
          ]}
        />
      </div>

      <Modal
        open={markingLost}
        title="Mark Quote as Lost"
        onClose={() => setMarkingLost(false)}
        backdropDismissible={false}
        footer={
          <ModalFooter
            onCancel={() => setMarkingLost(false)}
            onConfirm={lostForm.handleSubmit(onMarkLost)}
            confirmLabel="Mark Lost"
            confirmVariant="destructive"
            loading={lostForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={lostForm.handleSubmit(onMarkLost)}>
          <Textarea label="Reason" required {...lostForm.register('reason', { required: true })} />
        </form>
      </Modal>

      <Modal
        open={converting}
        title="Convert to Load"
        onClose={() => setConverting(false)}
        footer={
          <ModalFooter
            onCancel={() => setConverting(false)}
            onConfirm={convertForm.handleSubmit(onConvert)}
            confirmLabel="Convert"
            loading={convertForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={convertForm.handleSubmit(onConvert)}>
          {convertError ? <p style={{ color: 'var(--danger-600)' }}>{convertError}</p> : null}
          <p>
            Confirm the rate for this booking (Workflow 4 §4.7 — always required, even if
            unchanged).
          </p>
          <CurrencyInput
            label="Confirmed Customer Rate"
            required
            {...convertForm.register('confirmedCustomerRate', { required: true })}
          />
          {customer?.status === 'INACTIVE' ? (
            <Toggle
              label="Customer is Inactive — proceed anyway"
              checked={inactiveOverride}
              onChange={(e) => setInactiveOverride(e.target.checked)}
            />
          ) : null}
        </form>
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
