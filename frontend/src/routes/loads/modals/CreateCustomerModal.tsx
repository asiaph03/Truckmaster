import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PAYMENT_TERMS } from '@tms/shared-constants';
import {
  customersApi,
  type Customer,
  type CreateCustomerRequest,
  type CustomerDuplicateConflictDetails,
} from '../../../api';
import { ApiError } from '../../../api/errors';
import { Modal, ModalFooter, Select, TextField } from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';

const schema = z.object({
  legalName: z.string().min(1, 'Legal name is required.'),
  billingAddressLine1: z.string().min(1, 'Address is required.'),
  billingCity: z.string().min(1, 'City is required.'),
  billingState: z.string().min(1, 'State is required.'),
  billingZip: z.string().min(1, 'ZIP is required.'),
  billingCountry: z.string().optional(),
  primaryContactName: z.string().min(1, 'Contact name is required.'),
  primaryContactEmail: z.string().email('Enter a valid email address.'),
  primaryContactPhone: z.string().min(1, 'Phone is required.'),
  paymentTermsOverride: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const PAYMENT_TERMS_OPTIONS = PAYMENT_TERMS.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));

export interface CreateCustomerModalInitialValues {
  legalName?: string;
  billingAddressLine1?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
}

/**
 * Rate Confirmation → New Load auto-populate feature — reuses the SAME
 * form fields, validation, and duplicate-protection flow as
 * CustomerCreatePage.tsx (Workflow 2 §2.1/§2.2), adapted into a modal so
 * it can be opened from within the New Load page without navigating away
 * (CustomerCreatePage itself is not reusable as-is — it's hardwired to
 * useNavigate() for both routing breadcrumbs and its post-create
 * redirect; this component duplicates the form/duplicate-modal JSX
 * rather than the page shell, and replaces the redirect with an
 * `onCreated` callback, mirroring CreateCarrierPaymentModal's exact
 * open/onClose/onCreated shape).
 *
 * Extraction-derived `initialValues` only ever prefill editable fields —
 * every field remains a normal, fully-editable input. Customer creation
 * itself still goes through the real `POST /customers` endpoint with the
 * exact same server-side validation and duplicate detection as the
 * standalone page — this modal never bypasses either.
 */
export function CreateCustomerModal({
  open,
  initialValues,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialValues?: CreateCustomerModalInitialValues;
  onClose: () => void;
  onCreated: (customer: Customer) => void;
}) {
  const toast = useToast();
  const [duplicates, setDuplicates] = useState<CustomerDuplicateConflictDetails | null>(null);
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  // Re-seed the form whenever a fresh extraction hands over new initial
  // values (e.g. the modal is opened again after a different upload) —
  // react-hook-form's own `defaultValues` only apply on first mount.
  useEffect(() => {
    if (open) reset({ ...initialValues });
  }, [open, initialValues, reset]);

  async function submitCustomer(values: FormValues, acknowledgeDuplicates = false) {
    setServerError(null);
    const body: CreateCustomerRequest = {
      ...values,
      paymentTermsOverride: (values.paymentTermsOverride || undefined) as never,
      acknowledgeDuplicates,
    };
    try {
      const created = await customersApi.create(body);
      toast.success('Customer created.');
      setDuplicates(null);
      setPendingValues(null);
      onCreated(created);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        const details = error.details as CustomerDuplicateConflictDetails | undefined;
        if (details?.reasonCode === 'POSSIBLE_DUPLICATE_CUSTOMER') {
          setDuplicates(details);
          setPendingValues(values);
          return;
        }
      }
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <>
      <Modal
        open={open}
        title="Create Customer"
        onClose={onClose}
        size="form"
        footer={
          <ModalFooter
            onCancel={onClose}
            onConfirm={handleSubmit((v) => submitCustomer(v))}
            confirmLabel="Create Customer"
            loading={isSubmitting}
          />
        }
      >
        {serverError ? (
          <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
            {serverError}
          </div>
        ) : null}

        <form onSubmit={handleSubmit((v) => submitCustomer(v))} noValidate>
          <h3 className="detail-card-title">Company Info</h3>
          <TextField
            label="Legal Name"
            required
            {...register('legalName')}
            error={errors.legalName?.message}
          />

          <h3 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
            Billing Address
          </h3>
          <TextField
            label="Address Line 1"
            required
            {...register('billingAddressLine1')}
            error={errors.billingAddressLine1?.message}
          />
          <div className="detail-card-grid">
            <TextField
              label="City"
              required
              {...register('billingCity')}
              error={errors.billingCity?.message}
            />
            <TextField
              label="State"
              required
              {...register('billingState')}
              error={errors.billingState?.message}
            />
            <TextField
              label="ZIP"
              required
              {...register('billingZip')}
              error={errors.billingZip?.message}
            />
            <TextField label="Country" {...register('billingCountry')} placeholder="US" />
          </div>

          <h3 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
            Primary Contact
          </h3>
          <TextField
            label="Contact Name"
            required
            {...register('primaryContactName')}
            error={errors.primaryContactName?.message}
          />
          <div className="detail-card-grid">
            <TextField
              label="Email"
              type="email"
              required
              {...register('primaryContactEmail')}
              error={errors.primaryContactEmail?.message}
            />
            <TextField
              label="Phone"
              required
              {...register('primaryContactPhone')}
              error={errors.primaryContactPhone?.message}
            />
          </div>

          <h3 className="detail-card-title" style={{ marginTop: 'var(--space-4)' }}>
            Terms
          </h3>
          <Select
            label="Payment Terms"
            placeholder="Inherit organization default"
            options={PAYMENT_TERMS_OPTIONS}
            {...register('paymentTermsOverride')}
          />
        </form>
      </Modal>

      <Modal
        open={duplicates !== null}
        title="Possible Duplicate"
        onClose={() => setDuplicates(null)}
        backdropDismissible={false}
        footer={
          <ModalFooter
            cancelLabel="Cancel"
            onCancel={() => setDuplicates(null)}
            confirmLabel="Continue Anyway"
            onConfirm={() => pendingValues && submitCustomer(pendingValues, true)}
            loading={isSubmitting}
          />
        }
      >
        <p>One or more possible duplicate customers were found:</p>
        <ul>
          {duplicates?.matches.map((m) => (
            <li key={m.customerId}>
              {m.legalName} — matched on {m.matchedOn.join(', ')}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
