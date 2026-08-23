import { useForm } from 'react-hook-form';
import { carrierPayApi, type CreateCarrierPaymentRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import {
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
    formState: { errors, isSubmitting },
  } = useForm<CreateCarrierPaymentRequest>({ defaultValues: { paymentType: 'PARTIAL' } });

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
        <CurrencyInput label="Amount" required {...register('amount', { required: true })} />
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
