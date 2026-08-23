import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EQUIPMENT_TYPES } from '@tms/shared-constants';
import { customersApi, quotesApi, type CreateQuoteRequest } from '../../api';
import { ApiError } from '../../api/errors';
import {
  Breadcrumb,
  Button,
  CurrencyInput,
  DatePicker,
  SearchableCombobox,
  Select,
  StopListEditor,
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
  expirationDate: string;
}

/** No locked screen design exists (approved plan §7 decision 3) — built against the Phase 2 creation-form convention. */
export function QuoteCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [stops, setStops] = useState<StopFormValue[]>([]);
  const [stopsError, setStopsError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { customerId: searchParams.get('customerId') ?? '' },
  });

  async function onSubmit(values: FormValues) {
    const stopsValidation = validateStops(stops);
    setStopsError(stopsValidation);
    if (stopsValidation) return;

    setServerError(null);
    const body: CreateQuoteRequest = {
      customerId: values.customerId,
      stops: sequenceStops(stops).map((s) => ({
        sequence: s.sequence,
        stopType: s.stopType as 'PICKUP' | 'DELIVERY',
        addressCity: s.city,
        addressState: s.state,
        addressZip: s.zip,
        appointmentNotes: s.appointmentNotes || undefined,
      })),
      equipmentType: values.equipmentType as CreateQuoteRequest['equipmentType'],
      customerRate: values.customerRate,
      expirationDate: values.expirationDate || undefined,
    };

    try {
      const quote = await quotesApi.create(body);
      navigate(`/quotes/${quote.id}`);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <Breadcrumb items={[{ label: 'Quotes', to: '/quotes' }, { label: 'New Quote' }]} />
      <h1 className="detail-page-title">New Quote</h1>

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
                options={customers.map((c) => ({ value: c.id, label: c.legalName }))}
                error={errors.customerId ? 'Customer is required.' : undefined}
              />
            )}
          />
          <Select
            label="Equipment Type"
            required
            options={EQUIPMENT_OPTIONS}
            {...register('equipmentType', { required: true })}
          />
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Stops (Lane)</h2>
          <StopListEditor
            mode="lane"
            stops={stops}
            onChange={setStops}
            error={stopsError ?? undefined}
          />
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Rate &amp; Expiration</h2>
          <CurrencyInput
            label="Customer Rate"
            required
            {...register('customerRate', { required: true })}
          />
          <DatePicker
            label="Expiration Date"
            helperText="Defaults to 7 days from now if left blank."
            {...register('expirationDate')}
          />
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button type="submit" loading={isSubmitting}>
            Create Quote
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/quotes')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
