import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { PAYMENT_TERMS } from '@tms/shared-constants';
import {
  customersApi,
  type CreateCustomerRequest,
  type CustomerDuplicateConflictDetails,
} from '../../api';
import { ApiError } from '../../api/errors';
import { Breadcrumb, Button, Modal, ModalFooter, Select, TextField } from '../../components/ui';
import '../shared/DetailPage.css';

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

export function CustomerCreatePage() {
  const navigate = useNavigate();
  const [duplicates, setDuplicates] = useState<CustomerDuplicateConflictDetails | null>(null);
  const [pendingValues, setPendingValues] = useState<FormValues | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function submitCustomer(values: FormValues, acknowledgeDuplicates = false) {
    setServerError(null);
    const body: CreateCustomerRequest = {
      ...values,
      paymentTermsOverride: (values.paymentTermsOverride || undefined) as never,
      acknowledgeDuplicates,
    };
    try {
      const created = await customersApi.create(body);
      navigate(`/customers/${created.id}`);
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
    <div>
      <Breadcrumb items={[{ label: 'Customers', to: '/customers' }, { label: 'New Customer' }]} />
      <h1 className="detail-page-title">New Customer</h1>

      {serverError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          {serverError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit((v) => submitCustomer(v))} style={{ maxWidth: 720 }} noValidate>
        <div className="detail-card">
          <h2 className="detail-card-title">Company Info</h2>
          <TextField
            label="Legal Name"
            required
            {...register('legalName')}
            error={errors.legalName?.message}
          />
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Billing Address</h2>
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
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Primary Contact</h2>
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
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Terms</h2>
          <Select
            label="Payment Terms"
            placeholder="Inherit organization default"
            options={PAYMENT_TERMS_OPTIONS}
            {...register('paymentTermsOverride')}
          />
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button type="submit" loading={isSubmitting}>
            Create Customer
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/customers')}>
            Cancel
          </Button>
        </div>
      </form>

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
              <button
                type="button"
                className="btn btn-tertiary"
                style={{ height: 'auto', padding: 0 }}
                onClick={() => navigate(`/customers/${m.customerId}`)}
              >
                {m.legalName}
              </button>{' '}
              — matched on {m.matchedOn.join(', ')}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
