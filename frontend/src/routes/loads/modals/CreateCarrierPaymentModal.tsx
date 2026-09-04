import { Controller, useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { carrierPayApi, type CreateCarrierPaymentRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import {
  Button,
  CurrencyInput,
  Modal,
  ModalFooter,
  Select,
  Textarea,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

const PAYMENT_TYPE_OPTIONS = [
  { value: 'DEPOSIT', label: 'Deposit' },
  { value: 'PARTIAL', label: 'Partial' },
  { value: 'BALANCE', label: 'Balance' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
];

/**
 * Load Detail's Financials tab — "Add Carrier Payment" (Workflow 9),
 * enabled once `Load.status ≥ DELIVERED`. Collects `method`/
 * `referenceNumber` upfront even though the backend types them optional
 * at Draft stage — there is no update endpoint for a Draft payment, so a
 * record created without them could never be submitted for approval.
 */
export function CreateCarrierPaymentModal({
  open,
  loadId,
  onClose,
  onCreated,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateCarrierPaymentRequest>({ defaultValues: { paymentType: 'PARTIAL' } });

  // Accessorial Charges on in-transit Loads — this is a PREVIEW only,
  // fetched fresh every time the modal opens; it never writes anything.
  // Reuses the exact same backend calculation create() itself uses
  // (CarrierPaymentService.computeCarrierBalance) — never a second,
  // divergent figure. Amount stays a completely normal, independently
  // editable field; "Use Remaining Balance" below only ever pre-fills it.
  const { data: balance } = useQuery({
    queryKey: ['carrier-payment-balance', loadId],
    queryFn: () => carrierPayApi.getRemainingBalance(loadId),
    enabled: open,
  });

  async function onSubmit(values: CreateCarrierPaymentRequest) {
    try {
      await carrierPayApi.create(loadId, {
        ...values,
        notes: values.notes || undefined,
      });
      toast.success('Carrier payment created as Draft.');
      reset({ paymentType: 'PARTIAL' });
      onCreated();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Add Carrier Payment"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Create"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Select label="Type" options={PAYMENT_TYPE_OPTIONS} {...register('paymentType')} />

        {balance ? (
          <div className="detail-card" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="detail-card-grid">
              <div>
                <div className="detail-field-label">Carrier Rate</div>
                <div className="detail-field-value">
                  {balance.carrierRate != null ? `$${balance.carrierRate}` : '—'}
                </div>
              </div>
              <div>
                <div className="detail-field-label">Carrier Accessorials</div>
                <div className="detail-field-value">${balance.carrierAccessorialsTotal}</div>
              </div>
              <div>
                <div className="detail-field-label">Paid to Date</div>
                <div className="detail-field-value">${balance.totalPaid}</div>
              </div>
              <div>
                <div className="detail-field-label">Remaining Carrier Balance</div>
                <div className="detail-field-value">
                  {balance.remainingCarrierBalance != null
                    ? `$${balance.remainingCarrierBalance}`
                    : '—'}
                </div>
              </div>
            </div>
            {balance.remainingCarrierBalance != null ? (
              <div style={{ marginTop: 'var(--space-2)' }}>
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  onClick={() =>
                    setValue('amount', balance.remainingCarrierBalance!, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                >
                  Use Remaining Balance
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <Controller
          name="amount"
          control={control}
          rules={{ required: true }}
          defaultValue=""
          render={({ field }) => (
            <CurrencyInput
              label="Amount"
              required
              value={field.value}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />
        <TextField
          label="Method"
          required
          error={errors.method ? 'Method is required.' : undefined}
          {...register('method', { required: true })}
        />
        <TextField
          label="Reference Number"
          required
          error={errors.referenceNumber ? 'Reference number is required.' : undefined}
          {...register('referenceNumber', { required: true })}
        />
        <Textarea label="Notes" {...register('notes')} rows={2} />
      </form>
    </Modal>
  );
}
