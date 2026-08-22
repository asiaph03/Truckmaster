import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { carriersApi, type CarrierDuplicateConflictDetails } from '../../api';
import { ApiError } from '../../api/errors';
import { Breadcrumb, Button, TextField } from '../../components/ui';
import '../shared/DetailPage.css';

const schema = z.object({
  legalName: z.string().min(1, 'Legal name is required.'),
  dba: z.string().optional(),
  mcNumber: z.string().min(1, 'MC number is required.'),
  dotNumber: z.string().min(1, 'DOT number is required.'),
  addressLine1: z.string().min(1, 'Address is required.'),
  city: z.string().min(1, 'City is required.'),
  state: z.string().min(1, 'State is required.'),
  zip: z.string().min(1, 'ZIP is required.'),
  primaryContactName: z.string().min(1, 'Contact name is required.'),
  primaryContactPhone: z.string().min(1, 'Phone is required.'),
  primaryContactEmail: z.string().email('Enter a valid email address.'),
});
type FormValues = z.infer<typeof schema>;

/**
 * MC/DOT duplicate is a hard block (Workflow 3 §3.2) — unlike Customer
 * creation, there is no "Continue Anyway" override; the error links to
 * the existing record instead.
 */
export function CarrierCreatePage() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const [existingCarrierId, setExistingCarrierId] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    setExistingCarrierId(null);
    try {
      const created = await carriersApi.create(values);
      navigate(`/carriers/${created.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        const details = error.details as CarrierDuplicateConflictDetails | undefined;
        setServerError(error.message);
        setExistingCarrierId(details?.existingCarrierId ?? null);
        return;
      }
      setServerError(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  return (
    <div>
      <Breadcrumb items={[{ label: 'Carriers', to: '/carriers' }, { label: 'New Carrier' }]} />
      <h1 className="detail-page-title">New Carrier</h1>

      {serverError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          {serverError}
          {existingCarrierId ? (
            <>
              {' '}
              <Button
                variant="tertiary"
                size="sm"
                onClick={() => navigate(`/carriers/${existingCarrierId}`)}
              >
                View existing carrier
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={handleSubmit(onSubmit)} style={{ maxWidth: 720 }} noValidate>
        <div className="detail-card">
          <h2 className="detail-card-title">Company Info</h2>
          <TextField
            label="Legal Name"
            required
            {...register('legalName')}
            error={errors.legalName?.message}
          />
          <TextField label="DBA" {...register('dba')} />
          <div className="detail-card-grid">
            <TextField
              label="MC Number"
              required
              {...register('mcNumber')}
              error={errors.mcNumber?.message}
            />
            <TextField
              label="DOT Number"
              required
              {...register('dotNumber')}
              error={errors.dotNumber?.message}
            />
          </div>
        </div>

        <div className="detail-card">
          <h2 className="detail-card-title">Address</h2>
          <TextField
            label="Address Line 1"
            required
            {...register('addressLine1')}
            error={errors.addressLine1?.message}
          />
          <div className="detail-card-grid">
            <TextField label="City" required {...register('city')} error={errors.city?.message} />
            <TextField
              label="State"
              required
              {...register('state')}
              error={errors.state?.message}
            />
            <TextField label="ZIP" required {...register('zip')} error={errors.zip?.message} />
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
              label="Phone"
              required
              {...register('primaryContactPhone')}
              error={errors.primaryContactPhone?.message}
            />
            <TextField
              label="Email"
              type="email"
              required
              {...register('primaryContactEmail')}
              error={errors.primaryContactEmail?.message}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button type="submit" loading={isSubmitting}>
            Create Carrier
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/carriers')}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
