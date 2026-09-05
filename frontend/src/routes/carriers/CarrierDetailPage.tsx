import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { Carrier, UpdateCarrierRequest } from '../../api';
import { carriersApi } from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
  ConfirmDialog,
  EligibilityBadge,
  Modal,
  ModalFooter,
  Tabs,
  TextField,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import { LoadsTab } from '../customers/tabs/LoadsTab';
import { OverviewTab } from './tabs/OverviewTab';
import { ComplianceTab } from './tabs/ComplianceTab';
import { InsuranceTab } from './tabs/InsuranceTab';
import { ContactsTab } from './tabs/ContactsTab';
import { DriversTab } from './tabs/DriversTab';
import { TrucksTab } from './tabs/TrucksTab';
import { TrailersTab } from './tabs/TrailersTab';
import { FactoringTab } from './tabs/FactoringTab';
import '../shared/DetailPage.css';

/**
 * Only the fields `UpdateCarrierDto` actually declares — the global
 * `ValidationPipe`'s `whitelist: true, forbidNonWhitelisted: true`
 * (configure-app.ts) rejects the entire request if the submitted body
 * carries any other property. `carrier` (the full `GET /carriers/:id`
 * response) also has `id`/`organizationId`/`mcNumber`/`dotNumber`/
 * `status`/`assignmentEligible`/`ineligibilityReasons`/
 * `createdByUserId`/`createdAt`/`contacts`/`insuranceRecords`/
 * `fmcsaVerifications`/`serviceAreas`/`factoringInfo`/`drivers`/
 * `trucks`/`trailers`, none of which are editable here — resetting the
 * form with the raw entity would carry all of those into the PATCH body
 * and the save would silently 400. Mirrors EditStopsModal's
 * `stopToFormValue` pattern.
 */
function carrierToFormValue(carrier: Carrier): UpdateCarrierRequest {
  return {
    legalName: carrier.legalName,
    dba: carrier.dba,
    addressLine1: carrier.addressLine1,
    city: carrier.city,
    state: carrier.state,
    zip: carrier.zip,
    primaryContactName: carrier.primaryContactName,
    primaryContactPhone: carrier.primaryContactPhone,
    primaryContactEmail: carrier.primaryContactEmail,
  };
}

export function CarrierDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [reactivating, setReactivating] = useState(false);

  const { data: carrier, isLoading } = useQuery({
    queryKey: ['carriers', id],
    queryFn: () => carriersApi.getById(id),
    enabled: Boolean(id),
  });

  const editForm = useForm<UpdateCarrierRequest>();

  async function onSaveEdit(values: UpdateCarrierRequest) {
    try {
      await carriersApi.update(id, values);
      await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
      toast.success('Carrier updated.');
      setEditing(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onActivate() {
    setActivateError(null);
    setActivating(true);
    try {
      await carriersApi.activate(id);
      await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
      toast.success('Carrier activated.');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ELIGIBILITY_ERROR') {
        const reasons = (error.details as { reasons?: string[] } | undefined)?.reasons ?? [];
        setActivateError(reasons.join('; ') || error.message);
      } else {
        setActivateError(error instanceof ApiError ? error.message : 'Something went wrong.');
      }
    } finally {
      setActivating(false);
    }
  }

  async function onBlock(reason?: string) {
    try {
      await carriersApi.block(id, { reason: reason ?? '' });
      await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
      toast.success('Carrier blocked.');
      setBlocking(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onDeactivate(reason?: string) {
    try {
      await carriersApi.deactivate(id, { reason: reason ?? '' });
      await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
      toast.success('Carrier deactivated.');
      setDeactivating(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function onReactivate(reason?: string) {
    try {
      await carriersApi.reactivate(id, { reason: reason ?? '' });
      await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
      toast.success('Carrier reactivated.');
      setReactivating(false);
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  if (isLoading || !carrier) {
    return <div>Loading…</div>;
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'insurance', label: 'Insurance' },
    { key: 'contacts', label: 'Contacts', count: carrier.contacts?.length },
    { key: 'drivers', label: 'Drivers', count: carrier.drivers?.length },
    { key: 'trucks', label: 'Trucks', count: carrier.trucks?.length },
    { key: 'trailers', label: 'Trailers', count: carrier.trailers?.length },
    { key: 'loads', label: 'Loads' },
    { key: 'factoring', label: 'Factoring' },
  ];

  return (
    <div>
      <Breadcrumb items={[{ label: 'Carriers', to: '/carriers' }, { label: carrier.legalName }]} />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">
            {carrier.legalName}
            {carrier.dba ? ` (DBA: ${carrier.dba})` : ''}
          </h1>
          <Badge
            label={carrier.status}
            color={getStatusBadgeColor('Carrier.status', carrier.status) ?? 'neutral'}
          />
          <EligibilityBadge
            eligible={carrier.assignmentEligible}
            reasons={carrier.ineligibilityReasons}
          />
        </div>
        <div className="detail-page-actions">
          {can('manageCarriers') ? (
            <Button
              variant="secondary"
              onClick={() => {
                editForm.reset(carrierToFormValue(carrier));
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : null}
          {can('activateCarrier') && carrier.status === 'PENDING' ? (
            <Button
              loading={activating}
              disabled={!carrier.activationReady}
              title={
                !carrier.activationReady ? (carrier.activationReasons ?? []).join('; ') : undefined
              }
              onClick={onActivate}
            >
              Activate Carrier
            </Button>
          ) : null}
          {can('manageCarriers') && carrier.status === 'ACTIVE' ? (
            <>
              <Button variant="destructive" onClick={() => setDeactivating(true)}>
                Deactivate Carrier
              </Button>
              <Button variant="destructive" onClick={() => setBlocking(true)}>
                Block Carrier
              </Button>
            </>
          ) : null}
          {can('manageCarriers') &&
          (carrier.status === 'INACTIVE' || carrier.status === 'BLOCKED') ? (
            <Button onClick={() => setReactivating(true)}>Reactivate Carrier</Button>
          ) : null}
        </div>
      </div>

      {activateError ? (
        <div className="detail-card" style={{ borderColor: 'var(--danger-600)' }}>
          Cannot activate — {activateError}
        </div>
      ) : null}

      <div className="detail-page-tabs">
        <Tabs tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'overview' ? <OverviewTab carrier={carrier} /> : null}
      {activeTab === 'compliance' ? <ComplianceTab carrier={carrier} /> : null}
      {activeTab === 'insurance' ? <InsuranceTab carrier={carrier} /> : null}
      {activeTab === 'contacts' ? <ContactsTab carrier={carrier} /> : null}
      {activeTab === 'drivers' ? <DriversTab carrier={carrier} /> : null}
      {activeTab === 'trucks' ? <TrucksTab carrier={carrier} /> : null}
      {activeTab === 'trailers' ? <TrailersTab carrier={carrier} /> : null}
      {activeTab === 'loads' ? <LoadsTab carrierId={carrier.id} /> : null}
      {activeTab === 'factoring' ? <FactoringTab carrier={carrier} /> : null}

      <Modal
        open={editing}
        title="Edit Carrier"
        onClose={() => setEditing(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setEditing(false)}
            onConfirm={editForm.handleSubmit(onSaveEdit)}
            confirmLabel="Save"
            loading={editForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={editForm.handleSubmit(onSaveEdit)}>
          <TextField label="Legal Name" {...editForm.register('legalName')} />
          <TextField label="DBA" {...editForm.register('dba')} />
          <TextField label="Address Line 1" {...editForm.register('addressLine1')} />
          <div className="detail-card-grid">
            <TextField label="City" {...editForm.register('city')} />
            <TextField label="State" {...editForm.register('state')} />
            <TextField label="ZIP" {...editForm.register('zip')} />
          </div>
          <TextField label="Primary Contact Name" {...editForm.register('primaryContactName')} />
          <TextField label="Primary Contact Phone" {...editForm.register('primaryContactPhone')} />
          <TextField label="Primary Contact Email" {...editForm.register('primaryContactEmail')} />
        </form>
      </Modal>

      <ConfirmDialog
        open={blocking}
        title="Block Carrier"
        message="This carrier will be blocked from new assignment and dispatch until reactivated. Existing assigned loads are not affected."
        confirmLabel="Block Carrier"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setBlocking(false)}
        onConfirm={onBlock}
      />

      <ConfirmDialog
        open={deactivating}
        title="Deactivate Carrier"
        message="This carrier will be marked Inactive and excluded from new assignment and dispatch until reactivated. Existing assigned loads are not affected."
        confirmLabel="Deactivate Carrier"
        confirmVariant="destructive"
        requireReason
        onCancel={() => setDeactivating(false)}
        onConfirm={onDeactivate}
      />

      <ConfirmDialog
        open={reactivating}
        title="Reactivate Carrier"
        message="This carrier will become eligible for new assignment again, subject to its current compliance status."
        confirmLabel="Reactivate Carrier"
        requireReason
        onCancel={() => setReactivating(false)}
        onConfirm={onReactivate}
      />
    </div>
  );
}
