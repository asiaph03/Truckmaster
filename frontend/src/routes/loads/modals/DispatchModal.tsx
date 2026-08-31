import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { carriersApi, loadsApi, type DispatchLoadRequest } from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, SearchableCombobox, TextField } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

/**
 * Shared assisted-transition flow (Load Detail header primary action
 * this phase; Kanban's assisted drag reuses it once built, Phase 4).
 * Driver/Truck/Trailer pickers source from the assigned carrier's
 * nested `GET /carriers/:id` arrays — no dedicated list endpoint exists
 * (confirmed in the approved plan). Selecting an option pre-fills the
 * free-text identity fields the backend actually stores; "+ Enter
 * manually" leaves them editable with no `source*Id` reference, per the
 * locked searchable-combobox pattern.
 *
 * `mode="edit"` reuses the same form for the Carrier & Dispatch tab's
 * post-dispatch "Edit" action (§5.4.4) — calls `PATCH .../dispatch`
 * instead of the initial `POST`, pre-filled from the existing
 * `DispatchRecord` via `initialValues`. Same component, not a second
 * implementation, per the locked "one implementation, two entry points"
 * rule (here: two call sites, dispatch vs. edit).
 */
export function DispatchModal({
  open,
  loadId,
  carrierId,
  mode = 'dispatch',
  initialValues,
  onClose,
  onDispatched,
}: {
  open: boolean;
  loadId: string;
  carrierId?: string;
  mode?: 'dispatch' | 'edit';
  initialValues?: DispatchLoadRequest;
  onClose: () => void;
  onDispatched: () => void;
}) {
  const toast = useToast();
  const [manualDriver, setManualDriver] = useState(false);
  const [manualTruck, setManualTruck] = useState(false);
  const [manualTrailer, setManualTrailer] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [selectedTruckId, setSelectedTruckId] = useState<string | null>(null);
  const [selectedTrailerId, setSelectedTrailerId] = useState<string | null>(null);

  const { data: carrier } = useQuery({
    queryKey: ['carriers', carrierId],
    queryFn: () => carriersApi.getById(carrierId!),
    enabled: open && Boolean(carrierId),
  });

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<DispatchLoadRequest>();

  useEffect(() => {
    if (open && mode === 'edit' && initialValues) reset(initialValues);
  }, [open, mode, initialValues, reset]);

  // The combobox path sets driverName/truckNumber/trailerNumber via
  // setValue() (no DOM input for register() to attach a ref to), so
  // `required` validation would never apply to those fields when a
  // carrier has drivers/trucks/trailers on file (only the manual-entry
  // TextFields registered it). Registering here — RHF's documented
  // pattern for a field backed entirely by a custom/controlled component
  // — makes the same rule apply regardless of which UI is showing, so
  // `errors.driverName`/`errors.truckNumber`/`errors.trailerNumber` are
  // populated (and can be surfaced) whether the user picks from the list
  // or types manually.
  useEffect(() => {
    register('driverName', { required: true });
    register('truckNumber', { required: true });
    register('trailerNumber', { required: true });
  }, [register]);

  async function onSubmit(values: DispatchLoadRequest) {
    try {
      if (mode === 'edit') await loadsApi.updateDispatch(loadId, values);
      else await loadsApi.dispatch(loadId, values);
      toast.success(mode === 'edit' ? 'Dispatch record updated.' : 'Load dispatched.');
      onDispatched();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  const drivers = (carrier?.drivers ?? []).filter((d) => d.active);
  const trucks = (carrier?.trucks ?? []).filter((t) => t.active);
  const trailers = (carrier?.trailers ?? []).filter((t) => t.active);

  return (
    <Modal
      open={open}
      title={mode === 'edit' ? 'Edit Dispatch Record' : 'Dispatch Load'}
      onClose={onClose}
      size="form"
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={handleSubmit(onSubmit)}
          confirmLabel={mode === 'edit' ? 'Save' : 'Dispatch Load'}
          loading={isSubmitting}
        />
      }
    >
      <form onSubmit={handleSubmit(onSubmit)}>
        {!manualDriver && drivers.length > 0 ? (
          <SearchableCombobox
            label="Driver"
            value={selectedDriverId}
            options={drivers.map((d) => ({ value: d.id, label: `${d.firstName} ${d.lastName}` }))}
            onChange={(value) => {
              setSelectedDriverId(value);
              const driver = drivers.find((d) => d.id === value);
              if (driver) {
                setValue('driverName', `${driver.firstName} ${driver.lastName}`);
                setValue('driverPhone', driver.phone);
                setValue('sourceDriverId', driver.id);
              }
            }}
            onEnterManually={() => setManualDriver(true)}
            error={errors.driverName ? 'Driver is required.' : undefined}
          />
        ) : (
          <>
            <TextField
              label="Driver Name"
              required
              error={errors.driverName ? 'Driver name is required.' : undefined}
              {...register('driverName', { required: true })}
            />
            <TextField
              label="Driver Phone"
              required
              error={errors.driverPhone ? 'Driver phone is required.' : undefined}
              {...register('driverPhone', { required: true })}
            />
          </>
        )}

        {!manualTruck && trucks.length > 0 ? (
          <SearchableCombobox
            label="Truck"
            value={selectedTruckId}
            options={trucks.map((t) => ({ value: t.id, label: t.unitNumber }))}
            onChange={(value) => {
              setSelectedTruckId(value);
              const truck = trucks.find((t) => t.id === value);
              if (truck) {
                setValue('truckNumber', truck.unitNumber);
                setValue('sourceTruckId', truck.id);
              }
            }}
            onEnterManually={() => setManualTruck(true)}
            error={errors.truckNumber ? 'Truck is required.' : undefined}
          />
        ) : (
          <TextField
            label="Truck Number"
            required
            error={errors.truckNumber ? 'Truck number is required.' : undefined}
            {...register('truckNumber', { required: true })}
          />
        )}

        {!manualTrailer && trailers.length > 0 ? (
          <SearchableCombobox
            label="Trailer"
            value={selectedTrailerId}
            options={trailers.map((t) => ({ value: t.id, label: t.unitNumber }))}
            onChange={(value) => {
              setSelectedTrailerId(value);
              const trailer = trailers.find((t) => t.id === value);
              if (trailer) {
                setValue('trailerNumber', trailer.unitNumber);
                setValue('sourceTrailerId', trailer.id);
              }
            }}
            onEnterManually={() => setManualTrailer(true)}
            error={errors.trailerNumber ? 'Trailer is required.' : undefined}
          />
        ) : (
          <TextField
            label="Trailer Number"
            required
            error={errors.trailerNumber ? 'Trailer number is required.' : undefined}
            {...register('trailerNumber', { required: true })}
          />
        )}
      </form>
    </Modal>
  );
}
