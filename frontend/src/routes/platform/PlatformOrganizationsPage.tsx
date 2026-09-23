import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { organizationsApi, type CreateOrganizationRequest } from '../../api';
import { ApiError } from '../../api/errors';
import { Badge, Button, DataTable, EmptyState, TextField } from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import { useSessionStore } from '../../auth/session-store';
import { formatBusinessDateTime } from '../loads/businessTimezone';
import '../shared/ListPage.css';
import '../shared/DetailPage.css';

interface CreatedOrganizationResult {
  legalName: string;
  primaryContactEmail: string;
}

/**
 * Platform-console org list + creation (`GET`/`POST /platform/organizations`,
 * PlatformSuperAdminGuard). Gated on `isPlatformSuperAdmin` specifically —
 * a User-level flag, never an OrganizationMembership role — so a normal
 * org Admin never gains access here just because their membership role
 * happens to be named "ADMIN".
 *
 * Phase 4 adds the list (the original create-only screen's own comment
 * previously noted no `GET` endpoint existed yet). No pagination — current
 * scale doesn't need it, per the locked Phase 4 design.
 */
export function PlatformOrganizationsPage() {
  const isPlatformSuperAdmin = useSessionStore((s) => s.isPlatformSuperAdmin);
  const navigate = useNavigate();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedOrganizationResult | null>(null);

  const {
    data: organizations = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['platform-organizations'],
    queryFn: () => organizationsApi.list(),
    enabled: isPlatformSuperAdmin,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationRequest>();

  async function onSubmit(values: CreateOrganizationRequest) {
    try {
      const { organization } = await organizationsApi.create(values);
      setCreated({
        legalName: organization.legalName,
        primaryContactEmail: values.primaryContactEmail,
      });
      toast.success('Organization created successfully.');
      setCreating(false);
      reset();
      await refetch();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (!isPlatformSuperAdmin) {
    return (
      <EmptyState
        icon={<Lock size={28} strokeWidth={1.5} color="var(--neutral-300)" />}
        message="You don't have access to this page."
      />
    );
  }

  return (
    <div>
      <div className="list-page-header">
        <div>
          <h1 className="list-page-title">Organizations</h1>
          <p style={{ margin: 0, color: 'var(--neutral-500)', fontSize: 'var(--text-small-size)' }}>
            Create a new organization and invite its first Admin.
          </p>
        </div>
        {!creating ? (
          <Button
            onClick={() => {
              setCreated(null);
              setCreating(true);
            }}
          >
            + Create Organization
          </Button>
        ) : null}
      </div>

      {created ? (
        <div className="detail-card" style={{ borderColor: 'var(--success-600)' }}>
          <h2 className="detail-card-title">Organization created successfully.</h2>
          <p style={{ margin: '0 0 var(--space-2)' }}>
            Organization: <strong>{created.legalName}</strong>
          </p>
          <p style={{ margin: 0 }}>
            An invitation has been sent to <strong>{created.primaryContactEmail}</strong>.
          </p>
        </div>
      ) : null}

      {!creating ? (
        <DataTable
          columns={[
            { key: 'legalName', header: 'Organization', render: (o) => o.legalName },
            {
              key: 'subscriptionStatus',
              header: 'Subscription',
              render: (o) => (
                <Badge
                  label={o.subscriptionStatus}
                  color={getStatusBadgeColor('Organization.subscriptionStatus', o.subscriptionStatus) ?? 'neutral'}
                />
              ),
            },
            {
              key: 'trialEndsAt',
              header: 'Trial Expires',
              render: (o) => (o.trialEndsAt ? formatBusinessDateTime(o.trialEndsAt) : '—'),
            },
            {
              key: 'maxCarriers',
              header: 'Carrier Limit',
              render: (o) => (o.maxCarriers === null ? 'Unlimited' : o.maxCarriers),
            },
            {
              key: 'maxDrivers',
              header: 'Driver Limit',
              render: (o) => (o.maxDrivers === null ? 'Unlimited' : o.maxDrivers),
            },
          ]}
          rows={organizations}
          rowKey={(o) => o.id}
          loading={isLoading}
          emptyMessage="No organizations yet."
          onRowClick={(o) => navigate(`/platform/organizations/${o.id}`)}
        />
      ) : null}

      {creating ? (
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="detail-card">
            <p style={{ margin: '0 0 var(--space-3)', color: 'var(--neutral-500)' }}>
              Creating this organization will send an invitation email to the Primary Contact to
              become its first Admin. Default Payment Terms starts at NET_30 and can be changed
              afterward in Organization Settings.
            </p>

            <h2 className="detail-card-title">Organization</h2>
            <div className="detail-card-grid">
              <TextField
                label="Legal Name"
                required
                error={errors.legalName?.message}
                {...register('legalName', { required: 'Legal name is required.' })}
              />
              <TextField
                label="Address Line 1"
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
              <TextField label="Country" placeholder="US" {...register('country')} />
            </div>
          </div>

          <div className="detail-card">
            <h2 className="detail-card-title">Primary Contact</h2>
            <div className="detail-card-grid">
              <TextField
                label="Primary Contact Name"
                required
                error={errors.primaryContactName?.message}
                {...register('primaryContactName', { required: 'Contact name is required.' })}
              />
              <TextField
                label="Primary Contact Email"
                type="email"
                required
                error={errors.primaryContactEmail?.message}
                {...register('primaryContactEmail', {
                  required: 'Contact email is required.',
                  pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address.' },
                })}
              />
              <TextField
                label="Primary Contact Phone"
                required
                error={errors.primaryContactPhone?.message}
                {...register('primaryContactPhone', { required: 'Contact phone is required.' })}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Organization'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
