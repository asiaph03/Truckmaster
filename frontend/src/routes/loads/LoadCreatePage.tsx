import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { EQUIPMENT_TYPES, type EquipmentType } from '@tms/shared-constants';
import {
  customersApi,
  documentsApi,
  loadDraftsApi,
  loadsApi,
  type Customer,
  type CreateLoadRequest,
} from '../../api';
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
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Load Draft feature — the raw extraction result is kept in state
  // purely so it's available to maybeSaveDraft() the moment a resolved
  // customer turns out not to be Active (new OR existing) — see that
  // function below. NEVER re-sent to the extractor; only ever persisted
  // verbatim via loadDraftsApi.create, exactly once.
  const [lastExtraction, setLastExtraction] = useState<ExtractedRateConfirmationData | null>(null);
  const [lastExtractionId, setLastExtractionId] = useState<string | null>(null);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(searchParams.get('draftId'));

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', {}],
    queryFn: () => customersApi.list(),
  });

  const { data: draft } = useQuery({
    queryKey: ['load-drafts', activeDraftId],
    queryFn: () => loadDraftsApi.get(activeDraftId!),
    enabled: !!activeDraftId,
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

  /**
   * Applies every non-customer extracted field to the form. Shared by
   * live extraction (handleExtracted) and by draft-resume (the effect
   * below) — for a resumed draft the customer is already known exactly
   * (draft.customerId), so no re-matching is needed there.
   */
  function applyExtractionToForm(extraction: ExtractedRateConfirmationData) {
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

  /**
   * Load Draft feature — NON-NEGOTIABLE credit-saving requirement: a
   * Rate Confirmation is sent to the extractor at most once. This is the
   * ONLY place a LoadDraft is ever created, and it only ever snapshots
   * data already sitting in component state from the extraction that
   * already ran — never re-invokes rateConfirmationExtractionApi in any
   * way. A customer already Active needs no draft at all (today's
   * unchanged flow continues in the same session); `activeDraftId`
   * guards against saving twice in one session (e.g. if the same
   * extraction somehow resolves a customer more than once).
   */
  async function maybeSaveDraft(
    customer: Customer,
    // Accepted explicitly (not always read from state) because
    // handleExtracted calls this synchronously with values it just
    // received as its own parameters — setLastExtraction/
    // setLastExtractionId haven't flushed into `lastExtraction`/
    // `lastExtractionId` yet at that point in the same call stack. The
    // state versions remain the right source for handleCustomerCreated,
    // which always runs later, after that state has settled.
    extraction: ExtractedRateConfirmationData | null = lastExtraction,
    extractionId: string | null = lastExtractionId,
  ) {
    if (customer.status === 'ACTIVE') return;
    if (activeDraftId || !extraction || !extractionId) return;

    try {
      const created = await loadDraftsApi.create({
        extractionId,
        customerId: customer.id,
        extractedData: extraction,
      });
      setActiveDraftId(created.id);
      const next = new URLSearchParams(searchParams);
      next.set('draftId', created.id);
      setSearchParams(next, { replace: true });
    } catch {
      // The user can still finish booking in this same session, but
      // leaving the page now would lose everything — this must be
      // visible, never silent (a silent failure here is exactly the
      // "have to re-upload" bug this feature exists to prevent).
      setServerError(
        'Could not save this Load Draft. You can still book now in this session, but leaving the page will lose the extracted data — please finish booking or retry before navigating away.',
      );
    }
  }

  function handleExtracted(extraction: ExtractedRateConfirmationData, extractionId: string) {
    setUnresolvedCustomerName(null);
    setLastExtraction(extraction);
    setLastExtractionId(extractionId);

    // Customer — exact-normalized-match against the org's own already-
    // loaded list only (see the `normalize()` doc comment above). Never
    // resolves to a customerId server-side; never creates one.
    if (extraction.customer?.extractedName) {
      const target = normalize(extraction.customer.extractedName);
      const match = customers.find((c) => normalize(c.legalName) === target);
      if (match) {
        setValue('customerId', match.id, { shouldValidate: true });
        void maybeSaveDraft(match, extraction, extractionId);
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

    applyExtractionToForm(extraction);
  }

  function handleCustomerCreated(customer: Customer) {
    queryClient.setQueryData<Customer[]>(['customers', {}], (existing) =>
      existing ? [...existing, customer] : [customer],
    );
    setValue('customerId', customer.id, { shouldValidate: true });
    setUnresolvedCustomerName(null);
    setCreatingCustomer(false);
    void maybeSaveDraft(customer);
  }

  // Resume — restores every extracted field and the exact customer from
  // a persisted draft. Never touches rateConfirmationExtractionApi; the
  // draft's extractedData (Postgres, durable) is the only source used.
  useEffect(() => {
    if (!draft) return;
    applyExtractionToForm(draft.extractedData);
    setValue('customerId', draft.customerId, { shouldValidate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const customerId = watch('customerId');

  // Live customer status — a user can sit on this page (e.g. waiting on
  // a Load Draft's customer approval) for a long time; neither the
  // `customers` list query above nor the one-time GET /load-drafts/:id
  // response revalidate on their own (the app's QueryClient default is
  // `refetchOnWindowFocus: false`, deliberately, everywhere else). This
  // one query is scoped to just the selected customer and opts back into
  // focus-revalidation ONLY here — event-driven (on regaining focus),
  // never interval polling. Falls back to the already-loaded list entry
  // so there's no flash of "no customer" before this resolves; once it
  // resolves, it's the authoritative source for every status-derived
  // flag below and for the draft banner. Never touches extraction,
  // stops, or any other form state — a status change here only ever
  // changes what's derived from `selectedCustomer`.
  const { data: liveCustomer } = useQuery({
    queryKey: ['customers', customerId],
    queryFn: () => customersApi.getById(customerId),
    enabled: !!customerId,
    refetchOnWindowFocus: true,
  });
  const selectedCustomer = useMemo(
    () => liveCustomer ?? customers.find((c) => c.id === customerId),
    [liveCustomer, customers, customerId],
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
      if (activeDraftId) {
        // Best-effort cleanup — the Load is already booked either way;
        // a leftover draft row is harmless clutter, never a blocker.
        loadDraftsApi.remove(activeDraftId).catch(() => {});
      }
      navigate(`/loads/${load.id}`);
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function viewRateConfirmationPdf() {
    if (!draft) return;
    try {
      const { url } = await documentsApi.getDownloadUrl(draft.rateConfirmationDocumentId);
      window.open(url, '_blank', 'noopener');
    } catch {
      setServerError('Could not get a download link for the Rate Confirmation.');
    }
  }

  return (
    <div>
      <Breadcrumb items={[{ label: 'Loads', to: '/loads/board' }, { label: 'New Load' }]} />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          maxWidth: 720,
        }}
      >
        <h1 className="detail-page-title">New Load (Direct Booking)</h1>
        <Button
          type="button"
          variant="tertiary"
          size="sm"
          onClick={() => navigate('/loads/drafts')}
        >
          Load Drafts
        </Button>
      </div>

      {serverError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          {serverError}
        </div>
      ) : null}

      {activeDraftId && draft ? (
        <div
          className="detail-card"
          style={{
            maxWidth: 720,
            borderColor:
              selectedCustomer?.status === 'ACTIVE'
                ? 'var(--success-600)'
                : selectedCustomer?.status === 'BLOCKED'
                  ? 'var(--danger-600)'
                  : 'var(--warning-600)',
          }}
        >
          <h2 className="detail-card-title">
            {selectedCustomer?.status === 'ACTIVE'
              ? 'Customer Approved — Ready to Book'
              : selectedCustomer?.status === 'BLOCKED'
                ? 'Customer Blocked — Cannot Book'
                : 'New Customer — Compliance Approval Required'}
          </h2>
          <p style={{ margin: 0 }}>
            Customer: <strong>{selectedCustomer?.legalName ?? draft.customerLegalName}</strong>
            <br />
            Status: {selectedCustomer?.status ?? draft.customerStatus}
          </p>
          <Button type="button" variant="tertiary" size="sm" onClick={viewRateConfirmationPdf}>
            View Rate Confirmation PDF ({draft.rateConfirmationFileName})
          </Button>
        </div>
      ) : (
        <div style={{ maxWidth: 720 }}>
          <RateConfirmationDropzone onExtracted={handleExtracted} />
        </div>
      )}

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
