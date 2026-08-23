import { useForm, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { loadsApi, membershipsApi, type AssignDispatcherRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, SearchableCombobox } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/** Shared between the Dispatch Board Table row kebab menu and Load Detail. No status gate on the backend. */
export function AssignDispatcherModal({
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
  const { data: memberships = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => membershipsApi.list(),
    enabled: open,
  });

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AssignDispatcherRequest>();

  async function onSubmit(values: AssignDispatcherRequest) {
    try {
      await loadsApi.setDispatcher(loadId, values);
      toast.success('Dispatcher assigned.');
      onAssigned();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Assign Dispatcher"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Assign"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Controller
          name="dispatcherUserId"
          control={control}
          rules={{ required: true }}
          render={({ field }) => (
            <SearchableCombobox
              label="Dispatcher"
              required
              value={field.value || null}
              onChange={(value) => field.onChange(value ?? '')}
              options={memberships.map((m) => ({ value: m.userId, label: m.user.name }))}
              error={errors.dispatcherUserId ? 'Dispatcher is required.' : undefined}
            />
          )}
        />
      </form>
    </Modal>
  );
}
