import { useForm } from 'react-hook-form';
import { loadsApi, type InitiateReturnRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import { DatePicker, Modal, ModalFooter, TextField, Textarea } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/**
 * Return Product feature — "Initiate Return". A dedicated modal, not a
 * repurposed Edit Stops/StopListEditor (that component is edit-existing-
 * stops-only, `allowAddRemove={false}` in this exact use case, and its
 * add/remove/reorder shape doesn't fit "always exactly these 2 stops").
 * Always creates both a Return Pickup and a Return Delivery stop together
 * — a return is never one without the other.
 */
export function InitiateReturnModal({
  open,
  loadId,
  onClose,
  onInitiated,
}: {
  open: boolean;
  loadId: string;
  onClose: () => void;
  onInitiated: () => void;
}) {
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<InitiateReturnRequest>();

  async function onSubmit(values: InitiateReturnRequest) {
    try {
      await loadsApi.initiateReturn(loadId, values);
      toast.success('Return initiated.');
      reset();
      onInitiated();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <Modal
      open={open}
      title="Initiate Return"
      onClose={onClose}
      size="form"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel="Initiate Return"
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        <h3 className="detail-card-title">Return Pickup</h3>
        <TextField
          id="pickup-company-name"
          label="Company Name"
          required
          {...register('pickupStop.companyName', { required: true })}
        />
        <TextField
          id="pickup-address-line-1"
          label="Address Line 1"
          required
          {...register('pickupStop.addressLine1', { required: true })}
        />
        <div className="detail-card-grid">
          <TextField
            id="pickup-city"
            label="City"
            required
            {...register('pickupStop.city', { required: true })}
          />
          <TextField
            id="pickup-state"
            label="State"
            required
            {...register('pickupStop.state', { required: true })}
          />
          <TextField
            id="pickup-zip"
            label="ZIP"
            required
            {...register('pickupStop.zip', { required: true })}
          />
        </div>
        <DatePicker
          id="pickup-appointment"
          label="Appointment"
          withTime
          {...register('pickupStop.appointmentDatetime')}
        />
        <div className="detail-card-grid">
          <TextField
            id="pickup-contact-name"
            label="Contact Name"
            {...register('pickupStop.contactName')}
          />
          <TextField
            id="pickup-contact-phone"
            label="Contact Phone"
            {...register('pickupStop.contactPhone')}
          />
        </div>
        <Textarea id="pickup-notes" label="Notes" {...register('pickupStop.notes')} />

        <h3 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
          Return Delivery
        </h3>
        <TextField
          id="delivery-company-name"
          label="Company Name"
          required
          {...register('deliveryStop.companyName', { required: true })}
        />
        <TextField
          id="delivery-address-line-1"
          label="Address Line 1"
          required
          {...register('deliveryStop.addressLine1', { required: true })}
        />
        <div className="detail-card-grid">
          <TextField
            id="delivery-city"
            label="City"
            required
            {...register('deliveryStop.city', { required: true })}
          />
          <TextField
            id="delivery-state"
            label="State"
            required
            {...register('deliveryStop.state', { required: true })}
          />
          <TextField
            id="delivery-zip"
            label="ZIP"
            required
            {...register('deliveryStop.zip', { required: true })}
          />
        </div>
        <DatePicker
          id="delivery-appointment"
          label="Appointment"
          withTime
          {...register('deliveryStop.appointmentDatetime')}
        />
        <div className="detail-card-grid">
          <TextField
            id="delivery-contact-name"
            label="Contact Name"
            {...register('deliveryStop.contactName')}
          />
          <TextField
            id="delivery-contact-phone"
            label="Contact Phone"
            {...register('deliveryStop.contactPhone')}
          />
        </div>
        <Textarea id="delivery-notes" label="Notes" {...register('deliveryStop.notes')} />
      </form>
    </Modal>
  );
}
