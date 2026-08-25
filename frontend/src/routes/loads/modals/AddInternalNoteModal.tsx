import { useForm } from 'react-hook-form';
import { activityApi, type CreateInternalNoteRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, Textarea } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/** Load Detail's Activity History tab (UI_UX_DESIGN.md §5.4.4). Content only — timestamp/author are backend-set. */
export function AddInternalNoteModal({
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
  } = useForm<CreateInternalNoteRequest>();

  async function onSubmit(values: CreateInternalNoteRequest) {
    try {
      await activityApi.addInternalNote(loadId, values);
      toast.success('Internal note added.');
      reset();
      onAdded();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Add Internal Note"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Add Note"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <Textarea
          label="Note text"
          required
          rows={4}
          error={errors.content ? 'Note text is required.' : undefined}
          {...register('content', { required: true })}
        />
      </form>
    </Modal>
  );
}
