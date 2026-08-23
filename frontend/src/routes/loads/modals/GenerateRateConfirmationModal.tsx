import { useState } from 'react';
import { loadsApi } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, Toggle } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/**
 * Shared assisted-transition flow (Load Detail header primary action at
 * `CARRIER_ASSIGNED`, and the Carrier & Dispatch tab's own "Generate
 * Rate Confirmation" action once assigned — same "one implementation,
 * two entry points" pattern as AssignCarrierModal/DispatchModal).
 * UI_UX_DESIGN.md §5.4.4's Rate Confirmation Card: enabled once Carrier
 * + Carrier Rate are set, explicitly not gated on driver/truck/trailer.
 */
export function GenerateRateConfirmationModal({
  open,
  loadId,
  onClose,
  onGenerated,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const toast = useToast();
  const [sendEmail, setSendEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    setSubmitting(true);
    try {
      await loadsApi.generateRateConfirmation(loadId, { sendEmail });
      toast.success('Rate Confirmation generated.');
      setSendEmail(false);
      onGenerated();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Generate Rate Confirmation"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onConfirm}
          confirmLabel="Generate"
          loading={submitting}
        />
      }
    >
      <p>This creates the Rate Confirmation document for the assigned carrier.</p>
      <Toggle
        label="Send via email to the carrier"
        checked={sendEmail}
        onChange={(e) => setSendEmail(e.target.checked)}
      />
    </Modal>
  );
}
