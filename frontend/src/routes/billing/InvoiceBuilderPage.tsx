import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { billingApi, customersApi, loadsApi, type PodIncompleteWarningDetails } from '../../api';
import { ApiError } from '../../api/errors';
import {
  Breadcrumb,
  Button,
  DataTable,
  Modal,
  ModalFooter,
  SearchableCombobox,
  Stepper,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import '../shared/DetailPage.css';

const STEPS = [
  { key: 'select', label: 'Select Loads' },
  { key: 'review', label: 'Review & Build' },
];

/**
 * UI_UX_DESIGN.md §5.4.7a Invoice Builder — no locked design for a
 * standalone Invoice List existed, but the Builder's own 3-step flow
 * (Select Loads → conditional POD warning → Review & Build) is fully
 * specified. The POD warning is never pre-computed client-side; the
 * exact same check the backend runs is what actually gates creation
 * (`POST /invoices` → 409 `POD_INCOMPLETE_WARNING` → resubmit with
 * `podWarningAcknowledged: true`), so this UI can't drift from it.
 * "Review & Build" shows the Individual path's charge line items
 * read-only — the backend has no mechanism to accept edited amounts at
 * creation time, so an editable table here would be misleading.
 */
export function InvoiceBuilderPage() {
  const [searchParams] = useSearchParams();
  const preselectedLoadId = searchParams.get('loadId');
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<'select' | 'review'>('select');
  const [customerId, setCustomerId] = useState('');
  const [selectedLoadIds, setSelectedLoadIds] = useState<Set<string>>(new Set());
  const [podWarningLoads, setPodWarningLoads] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: preselectedLoad } = useQuery({
    queryKey: ['loads', preselectedLoadId],
    queryFn: () => loadsApi.getById(preselectedLoadId!),
    enabled: Boolean(preselectedLoadId) && !customerId,
  });
  useEffect(() => {
    if (preselectedLoad && !customerId) {
      setCustomerId(preselectedLoad.customerId);
      setSelectedLoadIds(new Set([preselectedLoad.id]));
    }
  }, [preselectedLoad, customerId]);

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });
  const { data: readyLoads = [] } = useQuery({
    queryKey: ['loads', 'ready-to-invoice', customerId],
    queryFn: () => loadsApi.readyToInvoice(customerId),
    enabled: Boolean(customerId),
  });

  const selectedLoads = readyLoads.filter((l) => selectedLoadIds.has(l.id));

  function toggleLoad(id: string) {
    setSelectedLoadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createInvoice(podWarningAcknowledged: boolean) {
    setSubmitting(true);
    try {
      const invoice = await billingApi.createInvoice({
        customerId,
        loadIds: [...selectedLoadIds],
        podWarningAcknowledged,
      });
      toast.success('Invoice created.');
      navigate(`/billing/invoices/${invoice.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'POD_INCOMPLETE_WARNING') {
        const details = error.details as PodIncompleteWarningDetails | undefined;
        setPodWarningLoads(details?.affectedLoads ?? []);
        return;
      }
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Breadcrumb
        items={[{ label: 'Invoices', to: '/billing/invoices' }, { label: 'New Invoice' }]}
      />
      <h1 className="detail-page-title">New Invoice</h1>

      <div className="load-detail-stepper">
        <Stepper steps={STEPS} currentIndex={step === 'select' ? 0 : 1} />
      </div>

      {step === 'select' ? (
        <div className="detail-card">
          <h2 className="detail-card-title">Customer & Equipment</h2>
          <SearchableCombobox
            label="Customer"
            required
            value={customerId || null}
            onChange={(value) => {
              setCustomerId(value ?? '');
              setSelectedLoadIds(new Set());
            }}
            options={customers.map((c) => ({ value: c.id, label: c.legalName }))}
          />

          {customerId ? (
            <>
              <h2 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
                Ready to Invoice
              </h2>
              <DataTable
                rows={readyLoads}
                rowKey={(l) => l.id}
                emptyMessage="No un-invoiced Delivered loads for this customer."
                columns={[
                  {
                    key: 'select',
                    header: '',
                    render: (l) => (
                      <input
                        type="checkbox"
                        checked={selectedLoadIds.has(l.id)}
                        onChange={() => toggleLoad(l.id)}
                      />
                    ),
                  },
                  { key: 'loadNumber', header: 'Load #', render: (l) => l.loadNumber },
                  {
                    key: 'delivered',
                    header: 'Status',
                    render: (l) => l.status,
                  },
                  {
                    key: 'chargesTotal',
                    header: 'Customer Chg.',
                    render: (l) => `$${l.customerChargesTotal}`,
                  },
                  { key: 'pod', header: 'POD Status', render: (l) => l.podStatus },
                ]}
              />
              <Button
                style={{ marginTop: 'var(--space-4)' }}
                disabled={selectedLoadIds.size === 0}
                onClick={() => setStep('review')}
              >
                Continue — {selectedLoadIds.size === 1 ? 'Individual' : 'Consolidated'} Invoice
                {selectedLoadIds.size > 0 ? ` (${selectedLoadIds.size})` : ''}
              </Button>
            </>
          ) : null}
        </div>
      ) : (
        <div className="detail-card">
          <h2 className="detail-card-title">
            {selectedLoads.length === 1 ? 'Individual Invoice' : 'Consolidated Invoice'}
          </h2>
          {selectedLoads.length === 1 ? (
            <DataTable
              rows={selectedLoads[0].chargeLineItems.filter((c) => c.side === 'CUSTOMER')}
              rowKey={(c) => c.id}
              emptyMessage="No customer-side charges on this Load."
              columns={[
                { key: 'description', header: 'Description', render: (c) => c.description || '—' },
                {
                  key: 'amount',
                  header: 'Amount',
                  render: (c) => (c.amount != null ? `$${c.amount}` : '—'),
                },
              ]}
            />
          ) : (
            <DataTable
              rows={selectedLoads}
              rowKey={(l) => l.id}
              columns={[
                { key: 'loadNumber', header: 'Load #', render: (l) => l.loadNumber },
                {
                  key: 'total',
                  header: 'Total',
                  render: (l) => `$${l.customerChargesTotal}`,
                },
              ]}
            />
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <Button loading={submitting} onClick={() => createInvoice(false)}>
              Save as Draft
            </Button>
            <Button variant="secondary" onClick={() => setStep('select')}>
              Back
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={podWarningLoads !== null}
        title="POD incomplete"
        onClose={() => setPodWarningLoads(null)}
        backdropDismissible={false}
        footer={
          <ModalFooter
            onCancel={() => setPodWarningLoads(null)}
            onConfirm={() => {
              setPodWarningLoads(null);
              createInvoice(true);
            }}
            confirmLabel="Proceed Anyway"
            confirmVariant="destructive"
            loading={submitting}
          />
        }
      >
        <p>This invoice contains a load with missing or incomplete POD documentation.</p>
      </Modal>
    </div>
  );
}
