import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { organizationsApi } from '../../api';
import { ApiError } from '../../api/errors';
import {
  Badge,
  Breadcrumb,
  Button,
  ConfirmDialog,
  EmptyState,
  QueryErrorState,
  TextField,
} from '../../components/ui';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import { useToast } from '../../components/ui/toastStore';
import { useSessionStore } from '../../auth/session-store';
import { formatBusinessDateTime } from '../loads/businessTimezone';
import '../shared/DetailPage.css';

function formatLimit(value: number | null): string {
  return value === null ? 'Unlimited' : String(value);
}

/** Blank input = unlimited (null). A non-blank input is parsed as a plain number — DTO-level validation (integer, >= 0) is the backend's job, not duplicated here. */
function parseLimitInput(input: string): number | null {
  const trimmed = input.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/**
 * Phase 4 — platform-console organization detail
 * (`GET /platform/organizations/:id`, `PATCH .../subscription`),
 * PlatformSuperAdminGuard. Same in-component `isPlatformSuperAdmin` gate
 * as PlatformOrganizationsPage — no shared route-guard component exists
 * in this codebase to reuse instead.
 *
 * Conversion is only offered for TRIAL/EXPIRED organizations, matching
 * the locked Phase 4 scope exactly — an already-ACTIVE or CANCELLED
 * organization has no conversion action here at all (not even a disabled
 * one), since editing an active subscription's limits and reactivating a
 * cancelled one are both explicitly out of scope for this phase.
 */
export function PlatformOrganizationDetailPage() {
  const isPlatformSuperAdmin = useSessionStore((s) => s.isPlatformSuperAdmin);
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [maxCarriersInput, setMaxCarriersInput] = useState('');
  const [maxDriversInput, setMaxDriversInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [converting, setConverting] = useState(false);

  const {
    data: organization,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['platform-organizations', id],
    queryFn: () => organizationsApi.getById(id),
    enabled: isPlatformSuperAdmin && Boolean(id),
  });

  if (!isPlatformSuperAdmin) {
    return (
      <EmptyState
        icon={<Lock size={28} strokeWidth={1.5} color="var(--neutral-300)" />}
        message="You don't have access to this page."
      />
    );
  }

  if (isLoading) {
    return <div>Loading…</div>;
  }

  if (isError || !organization) {
    return (
      <QueryErrorState
        message="Couldn't load this organization. Please try again."
        onRetry={() => refetch()}
      />
    );
  }

  const canConvert =
    organization.subscriptionStatus === 'TRIAL' || organization.subscriptionStatus === 'EXPIRED';
  const requestedMaxCarriers = parseLimitInput(maxCarriersInput);
  const requestedMaxDrivers = parseLimitInput(maxDriversInput);
  const carrierUsageWarning =
    requestedMaxCarriers !== null && requestedMaxCarriers < organization.qualifyingCarrierCount;
  const driverUsageWarning =
    requestedMaxDrivers !== null && requestedMaxDrivers < organization.qualifyingDriverCount;

  async function onConvert() {
    setConverting(true);
    try {
      await organizationsApi.convertSubscription(id, {
        maxCarriers: requestedMaxCarriers,
        maxDrivers: requestedMaxDrivers,
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-organizations'] });
      toast.success('Organization converted to an active subscription.');
      setConfirming(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    } finally {
      setConverting(false);
    }
  }

  return (
    <div>
      <Breadcrumb
        items={[
          { label: 'Organizations', to: '/platform/organizations' },
          { label: organization.legalName },
        ]}
      />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">{organization.legalName}</h1>
          <Badge
            label={organization.subscriptionStatus}
            color={
              getStatusBadgeColor('Organization.subscriptionStatus', organization.subscriptionStatus) ??
              'neutral'
            }
          />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Subscription</h2>
        <div className="detail-card-grid">
          <Field label="Status" value={organization.subscriptionStatus} />
          <Field
            label="Trial Started"
            value={
              organization.trialStartedAt ? formatBusinessDateTime(organization.trialStartedAt) : '—'
            }
          />
          <Field
            label="Trial Expires"
            value={organization.trialEndsAt ? formatBusinessDateTime(organization.trialEndsAt) : '—'}
          />
          <Field
            label="Converted At"
            value={
              organization.subscriptionConvertedAt
                ? formatBusinessDateTime(organization.subscriptionConvertedAt)
                : '—'
            }
          />
          <Field
            label="Converted By"
            value={organization.subscriptionConvertedByUserId ?? '—'}
          />
        </div>
      </div>

      <div className="detail-card">
        <h2 className="detail-card-title">Limits &amp; Usage</h2>
        <div className="detail-card-grid">
          <Field label="Carrier Limit" value={formatLimit(organization.maxCarriers)} />
          <Field label="Qualifying Carriers" value={String(organization.qualifyingCarrierCount)} />
          <Field label="Driver Limit" value={formatLimit(organization.maxDrivers)} />
          <Field label="Active Drivers" value={String(organization.qualifyingDriverCount)} />
        </div>
      </div>

      {canConvert ? (
        <div className="detail-card">
          <h2 className="detail-card-title">Convert to Active Subscription</h2>
          <p style={{ margin: '0 0 var(--space-3)', color: 'var(--neutral-500)' }}>
            Set the carrier and driver limits for this organization, then convert it from{' '}
            {organization.subscriptionStatus} to an active subscription. Leave a field blank for
            unlimited.
          </p>
          <div className="detail-card-grid">
            <TextField
              label="Max Carriers"
              placeholder="Unlimited"
              type="number"
              min={0}
              step={1}
              value={maxCarriersInput}
              onChange={(e) => setMaxCarriersInput(e.target.value)}
            />
            <TextField
              label="Max Drivers"
              placeholder="Unlimited"
              type="number"
              min={0}
              step={1}
              value={maxDriversInput}
              onChange={(e) => setMaxDriversInput(e.target.value)}
            />
          </div>
          {carrierUsageWarning ? (
            <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--warning-600)' }}>
              This organization currently has {organization.qualifyingCarrierCount} qualifying
              carriers. Setting the limit to {requestedMaxCarriers} will not affect existing
              carriers, but will prevent additional carriers from being created until usage falls
              below the limit.
            </p>
          ) : null}
          {driverUsageWarning ? (
            <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--warning-600)' }}>
              This organization currently has {organization.qualifyingDriverCount} active drivers.
              Setting the limit to {requestedMaxDrivers} will not affect existing drivers, but will
              prevent additional drivers from being created until usage falls below the limit.
            </p>
          ) : null}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Button onClick={() => setConfirming(true)}>Convert to Active</Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="Convert to Active Subscription"
        message={`This will convert ${organization.legalName} from ${organization.subscriptionStatus} to an active subscription with a carrier limit of ${formatLimit(requestedMaxCarriers)} and a driver limit of ${formatLimit(requestedMaxDrivers)}.`}
        confirmLabel="Convert to Active"
        loading={converting}
        onCancel={() => setConfirming(false)}
        onConfirm={onConvert}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{value}</div>
    </div>
  );
}
