import { useForm, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { carriersApi, loadsApi, type LogSourcingAttemptRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import {
  CurrencyInput,
  Modal,
  ModalFooter,
  Select,
  SearchableCombobox,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

const OUTCOME_OPTIONS = [
  { value: 'DECLINED', label: 'Declined' },
  { value: 'NO_RESPONSE', label: 'No Response' },
  { value: 'QUOTED', label: 'Quoted' },
];

/**
 * Carrier & Dispatch tab's "Log Sourcing Attempt" action (Workflow 5
 * §5.5–5.6) — records a permanent history row without changing the
 * Load's carrier assignment (that's `AssignCarrierModal`'s job, a
 * separate action, not this one — `ASSIGNED`/`REJECTED_AFTER_ASSIGNMENT`
 * outcomes are system-derived from those other actions, not selectable
 * here).
 */
export function LogSourcingAttemptModal({
  open,
  loadId,
  onClose,
  onLogged,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onLogged: () => void;
}) {
  const toast = useToast();
  const { data: carriers = [] } = useQuery({
    queryKey: ['carriers', {}],
    queryFn: () => carriersApi.list(),
    enabled: open,
  });

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<LogSourcingAttemptRequest>({ defaultValues: { outcome: 'DECLINED' } });

  async function onSubmit(values: LogSourcingAttemptRequest) {
    try {
      // `carrierRate` is an optional `@Matches(DECIMAL_RE)` field on the
      // backend, which rejects '' (an untouched CurrencyInput's value) as
      // not matching the decimal pattern — strip it to undefined instead.
      await loadsApi.logSourcingAttempt(loadId, {
        ...values,
        carrierRate: values.carrierRate || undefined,
      });
      toast.success('Sourcing attempt logged.');
      reset({ outcome: 'DECLINED' });
      onLogged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Log Sourcing Attempt"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Log Attempt"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Controller
          name="carrierId"
          control={control}
          rules={{ required: true }}
          render={({ field }) => (
            <SearchableCombobox
              label="Carrier"
              required
              value={field.value || null}
              onChange={(value) => field.onChange(value ?? '')}
              options={carriers.map((c) => ({ value: c.id, label: c.legalName }))}
              error={errors.carrierId ? 'Carrier is required.' : undefined}
            />
          )}
        />
        <Select label="Outcome" options={OUTCOME_OPTIONS} {...register('outcome')} />
        <CurrencyInput label="Carrier Rate (if quoted)" {...register('carrierRate')} />
      </form>
    </Modal>
  );
}
