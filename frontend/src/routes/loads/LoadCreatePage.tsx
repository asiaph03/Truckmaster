import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import { customersApi, loadsApi, type CreateLoadRequest } from '../../api';
import { ApiError } from '../../api/errors';
import {
  Breadcrumb,
  Button,
  CurrencyInput,
  SearchableCombobox,
  Select,
  StopListEditor,
  TextField,
  Toggle,
  validateStops,
  sequenceStops,
  type StopFormValue,
} from '../../components/ui';
import '../shared/DetailPage.css';

const EQUIPMENT_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));

interface FormValues {
  customerId: string;
  equipmentType: string;
  customerRate: string;
  customerPoNumber: string;
  bolNumber: string;
  pickupNumber: string;
  customerReferenceNumber: string;
}

/** No locked screen design exists (approved plan §7 decision 3) — built against the Phase 2 creation-form convention. */
export function LoadCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [stops, setStops] = useState<StopFormValue[]>([]);
  const [stopsError, setStopsError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [inactiveOverride, setInactiveOverride] = useState(false);

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { customerId: searchParams.get('customerId') ?? '' },
  });

  const customerId = watch('customerId');
  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );
  const customerBlocked = selectedCustomer?.status === 'BLOCKED';
  const customerProspect = selectedCustomer?.status === 'PROSPECT';
  const customerInactive = selectedCustomer?.status === 'INACTIVE';
  const bookingHardBlocked = customerBlocked || customerProspect;

  async function onSubmit(values: FormValues) {
    const stopsValidation = validateStops(stops);
    setStopsError(stopsValidation);
    if (stopsValidation) return;

    setServerError(null);
    const body: CreateLoadRequest = {
      customerId: values.customerId,
      stops: sequenceStops(stops).map((s) => ({
        sequence: s.sequence,
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
      equipmentType: values.equipmentType as CreateLoadRequest['equipmentType'],
      customerRate: values.customerRate,
      customerPoNumber: values.customerPoNumber || undefined,
      bolNumber: values.bolNumber || undefined,
      pickupNumber: values.pickupNumber || undefined,
      customerReferenceNumber: values.customerReferenceNumber || undefined,
      confirmInactiveCustomerOverride: customerInactive ? inactiveOverride : undefined,
    };

    try {
      const load = await loadsApi.create(body);
      navigate(`/loads/${load.id}`);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <Breadcrumb items={[{ label: 'Loads', to: '/loads/board' }, { label: 'New Load' }]} />
      <h1 className="detail-page-title">New Load (Direct Booking)</h1>

      {serverError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          {serverError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit(onSubmit)} style={{ maxWidth: 720 }} noValidate>
        <div className="detail-card">
          <h2 className="detail-card-title">Customer &amp; Equipment</h2>
          <Controller
            name="customerId"
            control={control}
            rules={{ required: true }}
            render={({ field }) => (
              <SearchableCombobox
                label="Customer"
                required
                value={field.value || null}
                onChange={(value) => field.onChange(value ?? '')}
                options={customers.map((c) => ({
                  value: c.id,
                  label: `${c.legalName} (${c.status})`,
                }))}
                error={errors.customerId ? 'Customer is required.' : undefined}
              />
            )}
          />
          {customerBlocked ? (
            <p style={{ color: 'var(--danger-600)', fontSize: 'var(--text-small-size)' }}>
              This customer is Blocked and cannot be booked.
            </p>
          ) : null}
          {customerProspect ? (
            <p style={{ color: 'var(--danger-600)', fontSize: 'var(--text-small-size)' }}>
              This customer must be Active before booking (currently Prospect).
            </p>
          ) : null}
          {customerInactive ? (
            <Toggle
              label="Customer is Inactive — proceed anyway"
              checked={inactiveOverride}
              onChange={(e) => setInactiveOverride(e.target.checked)}
            />
          ) : null}

          <Select
            label="Equipment Type"
            required
            options={EQUIPMENT_OPTIONS}
            {...register('equipmentType', { required: true })}
          />
          <CurrencyInput
            label="Customer Rate"
            required
            {...register('customerRate', { required: true })}
          />
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Stops</h2>
          <StopListEditor
            mode="full"
            stops={stops}
            onChange={setStops}
            error={stopsError ?? undefined}
          />
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Reference Numbers</h2>
          <div className="detail-card-grid">
            <TextField label="Customer PO Number" {...register('customerPoNumber')} />
            <TextField label="BOL Number" {...register('bolNumber')} />
            <TextField label="Pickup Number" {...register('pickupNumber')} />
            <TextField label="Customer Reference Number" {...register('customerReferenceNumber')} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button
            type="submit"
            loading={isSubmitting}
            disabled={bookingHardBlocked || (customerInactive && !inactiveOverride)}
          >
            Book Load
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/loads/board')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
