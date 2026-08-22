import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CUSTOMER_STATUSES } from '@tms/shared-constants';
import {
  customersApi,
  type ChangeCustomerStatusRequest,
  type UpdateCustomerRequest,
} from '../../api';
import { getStatusBadgeColor } from '../../components/ui/statusBadgeMap';
import {
  Badge,
  Breadcrumb,
  Button,
  Modal,
  ModalFooter,
  Select,
  Tabs,
  TextField,
} from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { usePermissions } from '../../hooks/usePermissions';
import { OverviewTab } from './tabs/OverviewTab';
import { ContactsTab } from './tabs/ContactsTab';
import { LocationsTab } from './tabs/LocationsTab';
import { RateAgreementsTab } from './tabs/RateAgreementsTab';
import { LoadsTab } from './tabs/LoadsTab';
import { InvoicesTab } from './tabs/InvoicesTab';
import '../shared/DetailPage.css';

const STATUS_OPTIONS = CUSTOMER_STATUSES.map((s) => ({ value: s, label: s }));

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);

  const { data: customer, isLoading } = useQuery({
    queryKey: ['customers', id],
    queryFn: () => customersApi.getById(id),
    enabled: Boolean(id),
  });

  const canEdit = can('manageCustomers');
  const canViewFinancialTabs = can('viewCustomerFinancialTabs');

  const editForm = useForm<UpdateCustomerRequest>();
  const statusForm = useForm<ChangeCustomerStatusRequest>();

  async function onSaveEdit(values: UpdateCustomerRequest) {
    await customersApi.update(id, values);
    await queryClient.invalidateQueries({ queryKey: ['customers', id] });
    toast.success('Customer updated.');
    setEditing(false);
  }

  async function onChangeStatus(values: ChangeCustomerStatusRequest) {
    await customersApi.setStatus(id, values);
    await queryClient.invalidateQueries({ queryKey: ['customers', id] });
    toast.success('Status updated.');
    setChangingStatus(false);
  }

  if (isLoading || !customer) {
    return <div>Loading…</div>;
  }

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'contacts', label: 'Contacts', count: customer.contacts?.length },
    { key: 'locations', label: 'Locations', count: customer.locations?.length },
    ...(canViewFinancialTabs
      ? [
          {
            key: 'rate-agreements',
            label: 'Rate Agreements',
            count: customer.rateAgreements?.length,
          },
        ]
      : []),
    { key: 'loads', label: 'Loads' },
    ...(canViewFinancialTabs ? [{ key: 'invoices', label: 'Invoices' }] : []),
  ];

  return (
    <div>
      <Breadcrumb
        items={[{ label: 'Customers', to: '/customers' }, { label: customer.legalName }]}
      />

      <div className="detail-page-header">
        <div className="detail-page-title-row">
          <h1 className="detail-page-title">{customer.legalName}</h1>
          <Badge
            label={customer.status}
            color={getStatusBadgeColor('Customer.status', customer.status) ?? 'neutral'}
          />
        </div>
        {canEdit ? (
          <div className="detail-page-actions">
            <Button
              variant="secondary"
              onClick={() => {
                editForm.reset(customer);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                statusForm.reset({ status: customer.status });
                setChangingStatus(true);
              }}
            >
              Change Status
            </Button>
          </div>
        ) : null}
      </div>

      <div className="detail-page-tabs">
        <Tabs tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'overview' ? <OverviewTab customer={customer} /> : null}
      {activeTab === 'contacts' ? <ContactsTab customer={customer} /> : null}
      {activeTab === 'locations' ? <LocationsTab customer={customer} /> : null}
      {activeTab === 'rate-agreements' ? <RateAgreementsTab customer={customer} /> : null}
      {activeTab === 'loads' ? <LoadsTab customerId={customer.id} /> : null}
      {activeTab === 'invoices' ? <InvoicesTab customerId={customer.id} /> : null}

      <Modal
        open={editing}
        title="Edit Customer"
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
          <TextField label="Billing Address Line 1" {...editForm.register('billingAddressLine1')} />
          <div className="detail-card-grid">
            <TextField label="City" {...editForm.register('billingCity')} />
            <TextField label="State" {...editForm.register('billingState')} />
            <TextField label="ZIP" {...editForm.register('billingZip')} />
          </div>
          <TextField label="Primary Contact Name" {...editForm.register('primaryContactName')} />
          <TextField label="Primary Contact Email" {...editForm.register('primaryContactEmail')} />
          <TextField label="Primary Contact Phone" {...editForm.register('primaryContactPhone')} />
        </form>
      </Modal>

      <Modal
        open={changingStatus}
        title="Change Status"
        onClose={() => setChangingStatus(false)}
        footer={
          <ModalFooter
            onCancel={() => setChangingStatus(false)}
            onConfirm={statusForm.handleSubmit(onChangeStatus)}
            confirmLabel="Update Status"
            loading={statusForm.formState.isSubmitting}
          />
        }
      >
        <form onSubmit={statusForm.handleSubmit(onChangeStatus)}>
          <Select label="Status" options={STATUS_OPTIONS} {...statusForm.register('status')} />
        </form>
      </Modal>
    </div>
  );
}
