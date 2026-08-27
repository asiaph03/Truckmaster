import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import {
  carriersApi,
  loadsApi,
  type AssignCarrierRequest,
  type EligibilityErrorDetails,
} from '../../../api';
import { ApiError } from '../../../api/errors';
import { CurrencyInput, Modal, ModalFooter, SearchableCombobox } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/**
 * Shared assisted-transition flow — used from Load Detail's header
 * primary action and Kanban's assisted drag (KanbanBoard.tsx, both
 * open this same modal): "one implementation, two entry points" per the
 * locked spec. Deliberately does not pre-filter to only eligible
 * carriers — surfaces the real `EligibilityError.details.reasons` list
 * from the backend instead of re-implementing the 7-condition check
 * client-side.
 */
export function AssignCarrierModal({
  open,
  loadId,
  onClose,
  onAssigned,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const toast = useToast();
  const [eligibilityReasons, setEligibilityReasons] = useState<string[] | null>(null);
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
  } = useForm<AssignCarrierRequest>();

  async function onSubmit(values: AssignCarrierRequest) {
    setEligibilityReasons(null);
    try {
      await loadsApi.assignCarrier(loadId, values);
      toast.success('Carrier assigned.');
      reset();
      onAssigned();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ELIGIBILITY_ERROR') {
        const reasons = (error.details as EligibilityErrorDetails | undefined)?.reasons ?? [];
        setEligibilityReasons(reasons.length > 0 ? reasons : [error.message]);
        return;
      }
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Assign Carrier"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Assign Carrier"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        {eligibilityReasons ? (
          <div
            className="detail-card"
            style={{ borderColor: 'var(--danger-600)', marginBottom: 'var(--space-3)' }}
          >
            <p style={{ margin: 0, fontWeight: 500 }}>Carrier is not eligible:</p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 'var(--space-4)' }}>
              {eligibilityReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
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
              options={carriers.map((c) => ({
                value: c.id,
                label: `${c.legalName} (${c.assignmentEligible ? 'Eligible' : 'Ineligible'})`,
              }))}
              error={errors.carrierId ? 'Carrier is required.' : undefined}
            />
          )}
        />
        <CurrencyInput
          label="Carrier Rate"
          required
          {...register('carrierRate', { required: true })}
        />
      </form>
    </Modal>
  );
}
