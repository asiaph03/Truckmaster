import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { billingApi, loadsApi, type AddChargeRequest } from '../../../api';
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

const SIDE_OPTIONS = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'CARRIER', label: 'Carrier' },
];

/**
 * Load Detail's Financials tab — Decision Log D9: add a charge to a Load
 * "at any time after booking," no approval step, fully audited. Always
 * lands as `source: ADJUSTMENT` server-side; the two `ORIGINAL` linehaul
 * rows are system-created only (booking and carrier assignment).
 */
export function AddChargeModal({
  open,
  loadId,
  onClose,
  onAdded,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const { data: chargeTypes = [] } = useQuery({
    queryKey: ['charge-types'],
    queryFn: () => billingApi.listChargeTypes(),
    enabled: open,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AddChargeRequest>({ defaultValues: { side: 'CUSTOMER' } });

  async function onSubmit(values: AddChargeRequest) {
    try {
      await loadsApi.addCharge(loadId, {
        ...values,
        quantity: values.quantity || undefined,
        description: values.description || undefined,
        notes: values.notes || undefined,
      });
      toast.success('Charge added.');
      reset({ side: 'CUSTOMER' });
      onAdded();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Add Charge"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Add Charge"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Select label="Side" options={SIDE_OPTIONS} {...register('side')} />
        <Select
          label="Charge Type"
          required
          options={chargeTypes.map((t) => ({ value: t.id, label: t.label }))}
          error={errors.chargeTypeId ? 'Charge type is required.' : undefined}
          {...register('chargeTypeId', { required: true })}
        />
        <TextField label="Description" {...register('description')} />
        <div className="detail-card-grid">
          <TextField label="Quantity" placeholder="1" {...register('quantity')} />
          <CurrencyInput label="Unit Rate" required {...register('unitRate', { required: true })} />
        </div>
        <Textarea label="Notes" {...register('notes')} rows={2} />
      </form>
    </Modal>
  );
}
