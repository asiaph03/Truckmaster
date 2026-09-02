import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EQUIPMENT_TYPES, type EquipmentType } from '@tms/shared-constants';
import { customersApi, loadsApi, type Customer, type CreateLoadRequest } from '../../api';
import type { ExtractedRateConfirmationData } from '../../api/rateConfirmationExtraction';
import { ApiError } from '../../api/errors';
import {
  Breadcrumb,
  Button,
  CurrencyInput,
  RateConfirmationDropzone,
  SearchableCombobox,
  Select,
  StopListEditor,
  TextField,
  Toggle,
  validateStops,
  sequenceStops,
  type StopFormValue,
} from '../../components/ui';
import {
  CreateCustomerModal,
  type CreateCustomerModalInitialValues,
} from './modals/CreateCustomerModal';
import '../shared/DetailPage.css';

const EQUIPMENT_OPTIONS = EQUIPMENT_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }));

/**
 * Rate Confirmation → New Load auto-populate feature — exactly mirrors
 * the backend's CustomerService `normalize()` (customer.service.ts),
 * the codebase's one consistent "does this extracted string correspond
 * to an existing record" idiom (also used by RateAgreementMatchingService
 * for lane matching). No fuzzy/trigram/Levenshtein matching exists
 * anywhere in this codebase — deliberately not introduced here either;
 * an extracted name that doesn't exact-match after normalization simply
 * leaves Customer unresolved rather than guessing.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Rate Confirmation → New Load auto-populate feature — approved, narrow
 * allowlist of `unmappedFields` (rate-con info with no dedicated form
 * field — see the extractor's own contract) that get auto-placed into a
 * stop's existing Notes field. Everything else `unmappedFields` might
 * contain (broker MC#, carrier name/contact, etc.) is deliberately left
 * out — it still shows in the unmapped-fields banner below, just never
 * auto-copied into Notes. Canonical labels (not the model's raw label
 * text) are used in the output for consistent formatting; only the
 * *value* is required to be preserved exactly, per the approved spec.
 * Order here is the order they're written to Notes.
 */
const EXTRACTED_NOTES_FIELDS: { canonical: string; pattern: RegExp }[] = [
  { canonical: 'Reefer Ref#', pattern: /reefer.*ref/i },
  { canonical: 'Mileage', pattern: /mileage/i },
  { canonical: 'Commodity', pattern: /commodity/i },
  { canonical: 'Pickup Weight', pattern: /weight/i },
  { canonical: 'Special Instructions', pattern: /special.*instruction/i },
  { canonical: 'Internal Order#', pattern: /internal.*order/i },
  { canonical: 'Invoice Email', pattern: /invoice.*email/i },
  { canonical: 'Detention Policy', pattern: /detention/i },
];

/** Missing/blank fields are simply omitted — never a blank line or a label with no value. */
function buildExtractedNotesBlock(unmappedFields: { label: string; value: string }[]): string {
  const lines: string[] = [];
  for (const { canonical, pattern } of EXTRACTED_NOTES_FIELDS) {
    const match = unmappedFields.find((f) => pattern.test(f.label) && f.value.trim().length > 0);
    if (match) lines.push(`${canonical}: ${match.value.trim()}`);
  }
  return lines.join('\n');
}

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
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [stops, setStops] = useState<StopFormValue[]>([]);
  const [stopsError, setStopsError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [inactiveOverride, setInactiveOverride] = useState(false);

  // Rate Confirmation → New Load auto-populate feature — everything
  // below is purely client-side form-prefill state. Nothing here ever
  // calls loadsApi.create or customersApi.create on its own; both remain
  // explicit, separate user actions (existing "Book Load" button below,
  // and CreateCustomerModal's own "Create Customer" button).
  const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);
  const [unmappedFields, setUnmappedFields] = useState<{ label: string; value: string }[]>([]);
  const [unresolvedCustomerName, setUnresolvedCustomerName] = useState<string | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [customerCreatePrefill, setCustomerCreatePrefill] =
    useState<CreateCustomerModalInitialValues>({});

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { customerId: searchParams.get('customerId') ?? '' },
  });

  function handleExtracted(extraction: ExtractedRateConfirmationData) {
    setUnresolvedCustomerName(null);

    // Customer — exact-normalized-match against the org's own already-
    // loaded list only (see the `normalize()` doc comment above). Never
    // resolves to a customerId server-side; never creates one.
    if (extraction.customer?.extractedName) {
      const target = normalize(extraction.customer.extractedName);
      const match = customers.find((c) => normalize(c.legalName) === target);
      if (match) {
        setValue('customerId', match.id, { shouldValidate: true });
      } else {
        setUnresolvedCustomerName(extraction.customer.extractedName);
        setCustomerCreatePrefill({
          legalName: extraction.customer.extractedName,
          billingAddressLine1: extraction.customer.billingAddressLine1 ?? undefined,
          billingCity: extraction.customer.billingCity ?? undefined,
          billingState: extraction.customer.billingState ?? undefined,
          billingZip: extraction.customer.billingZip ?? undefined,
          primaryContactName: extraction.customer.primaryContactName ?? undefined,
          primaryContactEmail: extraction.customer.primaryContactEmail ?? undefined,
          primaryContactPhone: extraction.customer.primaryContactPhone ?? undefined,
        });
      }
    }

    // Equipment — only ever one of the 3 real enum values or omitted;
    // the backend already constrains/validates this before it reaches
    // here, but never trust extracted data — confirm again client-side.
    if (
      extraction.equipmentType &&
      (EQUIPMENT_TYPES as readonly string[]).includes(extraction.equipmentType)
    ) {
      setValue('equipmentType', extraction.equipmentType as EquipmentType, {
        shouldValidate: true,
      });
    }

    if (extraction.customerRate) setValue('customerRate', extraction.customerRate);
    if (extraction.customerPoNumber) setValue('customerPoNumber', extraction.customerPoNumber);
    if (extraction.bolNumber) setValue('bolNumber', extraction.bolNumber);
    if (extraction.pickupNumber) setValue('pickupNumber', extraction.pickupNumber);
    if (extraction.customerReferenceNumber) {
      setValue('customerReferenceNumber', extraction.customerReferenceNumber);
    }

    // Stops — one flat, already-ordered array straight into
    // StopListEditor's own state shape. Preserves the exact document
    // order (never regrouped into "all pickups then all deliveries") and
    // supports any count/mix of pickups and deliveries. A stop with some
    // null fields still becomes one editable row with those left blank —
    // never dropped.
    //
    // The 8 approved unmappedFields (see EXTRACTED_NOTES_FIELDS) are
    // appended to the first PICKUP stop's existing Notes field (falling
    // back to the first stop of any type if there's no PICKUP) — there is
    // no Load-level Notes field to use instead (confirmed by inspection;
    // Load/CreateLoadDto has none). Reads the PREVIOUS stops state (via
    // the functional setStops form) so any notes text the user already
    // typed is preserved and appended to, never overwritten.
    const extractedNotesBlock = buildExtractedNotesBlock(extraction.unmappedFields);
    setStops((previousStops) => {
      const mapped: StopFormValue[] = extraction.stops.map((s) => ({
        stopType: s.stopType,
        companyName: s.companyName ?? '',
        addressLine1: s.addressLine1 ?? '',
        city: s.city ?? '',
        state: s.state ?? '',
        zip: s.zip ?? '',
        contactName: s.contactName ?? undefined,
        contactPhone: s.contactPhone ?? undefined,
        appointmentDatetime: s.appointmentDatetime ?? undefined,
      }));

      if (extractedNotesBlock) {
        const pickupIndex = mapped.findIndex((s) => s.stopType === 'PICKUP');
        const targetIndex = pickupIndex === -1 ? 0 : pickupIndex;
        const targetStop = mapped[targetIndex];
        if (targetStop) {
          const existingNotes = previousStops[targetIndex]?.notes?.trim();
          mapped[targetIndex] = {
            ...targetStop,
            notes: existingNotes
              ? `${existingNotes}\n\n${extractedNotesBlock}`
              : extractedNotesBlock,
          };
        }
      }

      return mapped;
    });
    setStopsError(null);

    setExtractionWarnings(extraction.warnings);
    setUnmappedFields(extraction.unmappedFields);
  }

  function handleCustomerCreated(customer: Customer) {
    queryClient.setQueryData<Customer[]>(['customers', {}], (existing) =>
      existing ? [...existing, customer] : [customer],
    );
    setValue('customerId', customer.id, { shouldValidate: true });
    setUnresolvedCustomerName(null);
    setCreatingCustomer(false);
  }

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

      <div style={{ maxWidth: 720 }}>
        <RateConfirmationDropzone onExtracted={handleExtracted} />
      </div>

      {extractionWarnings.length > 0 || unmappedFields.length > 0 ? (
        <div className="detail-card" style={{ maxWidth: 720, borderColor: 'var(--warning-600)' }}>
          {extractionWarnings.length > 0 ? (
            <>
              <h2 className="detail-card-title">Needs Review</h2>
              <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
                {extractionWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          ) : null}
          {unmappedFields.length > 0 ? (
            <>
              <h2 className="detail-card-title" style={{ marginTop: 'var(--space-3)' }}>
                Additional Information Found
              </h2>
              <ul style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
                {unmappedFields.map((f, i) => (
                  <li key={i}>
                    <strong>{f.label}:</strong> {f.value}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
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
          {unresolvedCustomerName ? (
            <div className="detail-card" style={{ borderColor: 'var(--warning-600)' }}>
              <p style={{ margin: 0 }}>
                ⚠ Customer not found: <strong>&quot;{unresolvedCustomerName}&quot;</strong>
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setCreatingCustomer(true)}
              >
                Create Customer
              </Button>
            </div>
          ) : null}
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
          <Controller
            name="customerRate"
            control={control}
            rules={{ required: true }}
            defaultValue=""
            render={({ field }) => (
              <CurrencyInput
                label="Customer Rate"
                required
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
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

      <CreateCustomerModal
        open={creatingCustomer}
        initialValues={customerCreatePrefill}
        onClose={() => setCreatingCustomer(false)}
        onCreated={handleCustomerCreated}
      />
    </div>
  );
}
