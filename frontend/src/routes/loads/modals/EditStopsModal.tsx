import { useEffect, useState } from 'react';
import { loadsApi, type Load, type Stop } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, StopListEditor, type StopFormValue } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/** Mirrors CalendarBoard's reschedule-modal datetime-local convention. */
function toDatetimeLocalValue(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stopToFormValue(stop: Stop): StopFormValue {
  return {
    stopType: stop.stopType,
    companyName: stop.companyName ?? '',
    addressLine1: stop.addressLine1 ?? '',
    city: stop.city,
    state: stop.state,
    zip: stop.zip,
    appointmentDatetime: stop.appointmentDatetime
      ? toDatetimeLocalValue(stop.appointmentDatetime)
      : '',
    contactName: stop.contactName ?? '',
    contactPhone: stop.contactPhone ?? '',
    notes: stop.notes ?? '',
  };
}

/**
 * Load Detail's Overview tab, Stops card — edits existing stops' fields
 * only (Type, Company Name, address, appointment, contact, notes). Never
 * adds, removes, or reorders a stop (`StopListEditor`'s `allowAddRemove`
 * is off here), and never touches `Stop.status`/`actualArrival`/
 * `actualDeparture` — those stay owned by the arrival/departure actions
 * on the Stops & Tracking tab.
 *
 * One atomic call on Save (`loadsApi.updateStops`) — not one request per
 * stop — matching the backend's single-transaction guarantee: either
 * every stop in the batch saves, or none do.
 */
export function EditStopsModal({
  open,
  load,
  onClose,
  onSaved,
}: {
  open: boolean;
  load: Load;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const sortedStops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const [stops, setStops] = useState<StopFormValue[]>(() => sortedStops.map(stopToFormValue));
  const [submitting, setSubmitting] = useState(false);

  // Re-seed from the latest server data every time the modal opens, so a
  // cancelled edit (or a background refetch while closed) never leaves
  // stale unsaved values sitting in state for next time.
  useEffect(() => {
    if (open) setStops(sortedStops.map(stopToFormValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load.stops]);

  async function onSave() {
    setSubmitting(true);
    try {
      await loadsApi.updateStops(load.id, {
        stops: stops.map((s, i) => ({
          sequence: sortedStops[i].sequence,
          stopType: s.stopType as 'PICKUP' | 'DELIVERY' | 'OTHER',
          companyName: s.companyName ?? '',
          addressLine1: s.addressLine1 ?? '',
          city: s.city,
          state: s.state,
          zip: s.zip,
          appointmentDatetime: s.appointmentDatetime || undefined,
          contactName: s.contactName || undefined,
          contactPhone: s.contactPhone || undefined,
          notes: s.notes || undefined,
        })),
      });
      toast.success('Stops updated.');
      onSaved();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Edit Stops"
      size="form"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSave}
          confirmLabel="Save"
          loading={submitting}
        />
      }
    >
      <StopListEditor mode="full" allowAddRemove={false} stops={stops} onChange={setStops} />
    </Modal>
  );
}
