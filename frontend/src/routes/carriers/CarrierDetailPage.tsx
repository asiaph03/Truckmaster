import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { UpdateCarrierRequest } from '../../api';
import { carriersApi } from '../../api';
import { ApiError } from '../../api/errors';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
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

export function CarrierDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  const { data: carrier, isLoading } = useQuery({
    queryKey: ['carriers', id],
    queryFn: () => carriersApi.getById(id),
    enabled: Boolean(id),
  });

  const editForm = useForm<UpdateCarrierRequest>();

  async function onSaveEdit(values: UpdateCarrierRequest) {
    await carriersApi.update(id, values);
    await queryClient.invalidateQueries({ queryKey: ['carriers', id] });
    toast.success('Carrier updated.');
    setEditing(false);
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
                editForm.reset(carrier);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : null}
          {can('activateCarrier') && carrier.status === 'PENDING' ? (
            <Button
              loading={activating}
              disabled={!carrier.assignmentEligible}
              title={
                !carrier.assignmentEligible
                  ? (carrier.ineligibilityReasons ?? []).join('; ')
                  : undefined
              }
              onClick={onActivate}
            >
              Activate Carrier
            </Button>
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
    </div>
  );
}
