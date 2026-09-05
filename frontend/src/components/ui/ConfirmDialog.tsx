import { useState } from 'react';
import { Modal, ModalFooter } from './Modal';
import { Textarea } from './Textarea';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** Cancel Load workflow — lets a dialog whose own confirm action is itself named "Cancel X" avoid an ambiguous "Cancel"/"Cancel" button pair (e.g. "Keep Load" instead). Defaults to ModalFooter's own "Cancel". */
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'destructive';
  /** When set, the confirm action requires a non-empty reason (e.g. reject-with-reason). */
  requireReason?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}

/**
 * UI_UX_DESIGN.md §5.2.5 "Confirmation Dialogs" — reserved for
 * irreversible/significant actions; not backdrop-dismissible when a
 * reason is required (a real decision point, not a stray click away).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'primary',
  requireReason = false,
  loading = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const canConfirm = !requireReason || reason.trim().length > 0;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      backdropDismissible={!requireReason}
      footer={
        <ModalFooter
          onCancel={onCancel}
          onConfirm={() => canConfirm && onConfirm(requireReason ? reason : undefined)}
          confirmLabel={confirmLabel}
          {...(cancelLabel ? { cancelLabel } : {})}
          confirmVariant={confirmVariant}
          loading={loading}
        />
      }
    >
      <p>{message}</p>
      {requireReason ? (
        <Textarea
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
        />
      ) : null}
    </Modal>
  );
}
