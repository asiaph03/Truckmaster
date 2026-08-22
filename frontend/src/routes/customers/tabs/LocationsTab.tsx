import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { CUSTOMER_LOCATION_TYPES } from '@tms/shared-constants';
import type { AddCustomerLocationRequest, Customer } from '../../../api';
import { customersApi } from '../../../api';
import {
  Badge,
  Button,
  DataTable,
  Modal,
  ModalFooter,
  Select,
  TextField,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

const TYPE_OPTIONS = CUSTOMER_LOCATION_TYPES.map((t) => ({ value: t, label: t }));

export function LocationsTab({ customer }: { customer: Customer }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddCustomerLocationRequest>();

  async function onSubmit(values: AddCustomerLocationRequest) {
    await customersApi.addLocation(customer.id, values);
    await queryClient.invalidateQueries({ queryKey: ['customers', customer.id] });
    toast.success('Location added.');
    reset();
    setAdding(false);
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Locations
        </h2>
        {can('manageCustomers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Location
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={customer.locations ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No locations yet."
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          {
            key: 'type',
            header: 'Type',
            render: (r) => <Badge label={r.locationType} color="neutral" />,
          },
          {
            key: 'address',
            header: 'Address',
            render: (r) => `${r.addressLine1}, ${r.city}, ${r.state} ${r.zip}`,
          },
          { key: 'contact', header: 'Contact', render: (r) => r.contactName ?? '—' },
          { key: 'hours', header: 'Operating Hours', render: (r) => r.operatingHours ?? '—' },
        ]}
      />

      <Modal
        open={adding}
        title="Add Location"
        onClose={() => setAdding(false)}
        size="form"
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Location"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField label="Name" required {...register('name', { required: true })} />
          <Select
            label="Type"
            required
            options={TYPE_OPTIONS}
            {...register('locationType', { required: true })}
          />
          <TextField
            label="Address Line 1"
            required
            {...register('addressLine1', { required: true })}
          />
          <div className="detail-card-grid">
            <TextField label="City" required {...register('city', { required: true })} />
            <TextField label="State" required {...register('state', { required: true })} />
            <TextField label="ZIP" required {...register('zip', { required: true })} />
          </div>
          <TextField label="Contact Name" {...register('contactName')} />
          <TextField label="Contact Phone" {...register('contactPhone')} />
          <TextField label="Operating Hours" {...register('operatingHours')} />
          <TextField label="Appointment Requirements" {...register('appointmentRequirements')} />
        </form>
      </Modal>
    </div>
  );
}
