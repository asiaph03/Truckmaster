import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadsApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, SearchableCombobox } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/**
 * Return Product feature — the lighter, post-creation "link to original
 * Load" action (approved over adding this to Create Load). Deliberately
 * a separate, explicit modal rather than part of Create Load, so that
 * flow stays unchanged. Fetches the full Load list for the picker (this
 * org's Load count is small; a dedicated search-as-you-type isn't
 * warranted yet — `loadsApi.search`'s `q` filter is there if it ever is).
 */
export function LinkReturnLoadModal({
  open,
  loadId,
  onClose,
  onLinked,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [originalLoadId, setOriginalLoadId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: loads = [] } = useQuery({
    queryKey: ['loads', 'link-return-options'],
    queryFn: () => loadsApi.list(),
    enabled: open,
  });

  async function onSubmit() {
    if (!originalLoadId) return;
    setSubmitting(true);
    try {
      await loadsApi.linkReturnLoad(loadId, { returnForLoadId: originalLoadId });
      toast.success('Linked to original Load.');
      setOriginalLoadId(null);
      onLinked();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Link as Return For"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSubmit}
          confirmLabel="Link Load"
          loading={submitting}
        />
      }
    >
      <SearchableCombobox
        label="Original Load"
        required
        value={originalLoadId}
        onChange={setOriginalLoadId}
        options={loads
          .filter((l) => l.id !== loadId)
          .map((l) => ({ value: l.id, label: l.loadNumber }))}
      />
    </Modal>
  );
}
