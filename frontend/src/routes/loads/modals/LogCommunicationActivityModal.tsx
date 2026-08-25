import { useForm } from 'react-hook-form';
import { activityApi, type CreateCommunicationActivityRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import {
  DatePicker,
  Modal,
  ModalFooter,
  Select,
  Textarea,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

const DIRECTION_OPTIONS = [
  { value: '', label: '—' },
  { value: 'INBOUND', label: 'Inbound' },
  { value: 'OUTBOUND', label: 'Outbound' },
];

/** Mirrors CalendarBoard's reschedule-modal datetime-local convention. */
function toDatetimeLocalValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FormValues {
  activityType: string;
  direction: '' | 'INBOUND' | 'OUTBOUND';
  contactPerson: string;
  notes: string;
  occurredAt: string;
}

/**
 * Load Detail's Activity History tab (UI_UX_DESIGN.md §5.4.4). activityType
 * is free text (matches the locked docs' example values — "Called
 * Carrier", "Sent Rate Confirmation" — and the existing Check Call
 * contactMethod convention), not a fixed dropdown. direction is always
 * optional (approved scope decision — no locked-doc precedent at all).
 */
export function LogCommunicationActivityModal({
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
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { direction: '', occurredAt: toDatetimeLocalValue() },
  });

  async function onSubmit(values: FormValues) {
    try {
      const body: CreateCommunicationActivityRequest = {
        activityType: values.activityType,
        notes: values.notes,
        direction: values.direction || undefined,
        contactPerson: values.contactPerson || undefined,
        occurredAt: new Date(values.occurredAt).toISOString(),
      };
      await activityApi.logCommunicationActivity(loadId, body);
      toast.success('Communication activity logged.');
      reset({ direction: '', occurredAt: toDatetimeLocalValue() });
      onAdded();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Log Communication Activity"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Log Activity"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <TextField
          label="Activity type/method"
          required
          placeholder="e.g. Called Carrier"
          error={errors.activityType ? 'Activity type is required.' : undefined}
          {...register('activityType', { required: true })}
        />
        <div className="detail-card-grid">
          <Select label="Direction" options={DIRECTION_OPTIONS} {...register('direction')} />
          <TextField label="Contact/Person" {...register('contactPerson')} />
        </div>
        <Textarea
          label="Notes/details"
          required
          rows={3}
          error={errors.notes ? 'Notes are required.' : undefined}
          {...register('notes', { required: true })}
        />
        <DatePicker label="Occurred At" withTime {...register('occurredAt', { required: true })} />
      </form>
    </Modal>
  );
}
