import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { PAYMENT_TERMS } from '@tms/shared-constants';
import { organizationsApi, type UpdateOrganizationRequest } from '../../api';
import { ApiError } from '../../api/errors';
import { Button, EmptyState, Select, TextField } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import { SettingsTabs } from './SettingsTabs';
import '../shared/ListPage.css';
import '../shared/DetailPage.css';

const PAYMENT_TERMS_OPTIONS = PAYMENT_TERMS.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }));

/**
 * Frontend Phase 14 — Organization Settings (locked route
 * `/settings/organization`, UI_UX_DESIGN.md §5.1.4/§5.1.6). Admin-only,
 * reusing the same `manageMemberships` permission key UsersRolesPage
 * already gates on (both frontend checks are UX-only — the backend's
 * `@Roles('ADMIN')` on `GET`/`PATCH /organizations/current` is the real
 * boundary). Exactly the 10 approved editable fields; `id`/
 * `createdByUserId`/`createdAt`/`status` are never rendered as inputs.
 * Changing `defaultPaymentTerms` here only affects future/default usage
 * — it never rewrites an existing Customer's already-set payment terms
 * (Workflow 2 §2.3), a rule enforced entirely server-side and unchanged
 * by this screen.
 */
export function OrganizationSettingsPage() {
  const { can } = usePermissions();
  const toast = useToast();
  const canManage = can('manageMemberships');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['organization-current'],
    queryFn: () => organizationsApi.getCurrent(),
    enabled: canManage,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdateOrganizationRequest>();

  useEffect(() => {
    if (data) reset(data);
  }, [data, reset]);

  async function onSubmit(values: UpdateOrganizationRequest) {
    try {
      const updated = await organizationsApi.update(values);
      reset(updated);
      toast.success('Organization settings saved.');
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (!canManage) {
    return (
      <EmptyState
        icon={<Lock size={28} strokeWidth={1.5} color="var(--neutral-300)" />}
        message="You don't have access to this page."
      />
    );
  }

  return (
    <div>
      <SettingsTabs />
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">Organization</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            Legal name, address, primary contact, and default payment terms for your organization.
          </p>
        </div>
      </div>

      {isLoading ? (
        <p style={{ color: 'var(--neutral-500)' }}>Loading…</p>
      ) : isError ? (
        <EmptyState message="Couldn't load organization settings. Please try again." />
      ) : (
        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="detail-card">
            <h2 className="detail-card-title">Organization</h2>
            <div className="detail-card-grid">
              <TextField
                label="Legal Name"
                required
                error={errors.legalName?.message}
                {...register('legalName', { required: 'Legal name is required.' })}
              />
              <TextField
                label="Address"
                required
                error={errors.addressLine1?.message}
                {...register('addressLine1', { required: 'Address is required.' })}
              />
              <TextField
                label="City"
                required
                error={errors.city?.message}
                {...register('city', { required: 'City is required.' })}
              />
              <TextField
                label="State"
                required
                error={errors.state?.message}
                {...register('state', { required: 'State is required.' })}
              />
              <TextField
                label="ZIP"
                required
                error={errors.zip?.message}
                {...register('zip', { required: 'ZIP is required.' })}
              />
              <TextField label="Country" {...register('country')} />
            </div>
          </div>

          <div className="detail-card">
            <h2 className="detail-card-title">Primary Contact</h2>
            <div className="detail-card-grid">
              <TextField
                label="Contact Name"
                required
                error={errors.primaryContactName?.message}
                {...register('primaryContactName', { required: 'Contact name is required.' })}
              />
              <TextField
                label="Contact Email"
                type="email"
                required
                error={errors.primaryContactEmail?.message}
                {...register('primaryContactEmail', { required: 'Contact email is required.' })}
              />
              <TextField
                label="Contact Phone"
                required
                error={errors.primaryContactPhone?.message}
                {...register('primaryContactPhone', { required: 'Contact phone is required.' })}
              />
            </div>
          </div>

          <div className="detail-card">
            <h2 className="detail-card-title">Terms</h2>
            <Select
              label="Default Payment Terms"
              options={PAYMENT_TERMS_OPTIONS}
              {...register('defaultPaymentTerms', { required: true })}
            />
          </div>

          <Button type="submit" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? 'Saving…' : 'Save Changes'}
          </Button>
        </form>
      )}
    </div>
  );
}
