import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { CUSTOMER_CONTACT_ROLES } from '@tms/shared-constants';
import type { AddCustomerContactRequest, Customer } from '../../../api';
import { customersApi } from '../../../api';
import {
  Badge,
  Button,
  DataTable,
  Modal,
  ModalFooter,
  Select,
  TextField,
  Toggle,
} from '../../../components/ui';
import { useToast } from '../../../components/ui/toastStore';
import { usePermissions } from '../../../hooks/usePermissions';

const ROLE_OPTIONS = CUSTOMER_CONTACT_ROLES.map((r) => ({ value: r, label: r }));

export function ContactsTab({ customer }: { customer: Customer }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<AddCustomerContactRequest>();

  async function onSubmit(values: AddCustomerContactRequest) {
    await customersApi.addContact(customer.id, values);
    await queryClient.invalidateQueries({ queryKey: ['customers', customer.id] });
    toast.success('Contact added.');
    reset();
    setAdding(false);
  }

  return (
    <div>
      <div className="detail-section-header">
        <h2 className="detail-card-title" style={{ margin: 0 }}>
          Contacts
        </h2>
        {can('manageCustomers') ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + Add Contact
          </Button>
        ) : null}
      </div>

      <DataTable
        rows={customer.contacts ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No contacts yet."
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'email', header: 'Email', render: (r) => r.email ?? '—' },
          { key: 'phone', header: 'Phone', render: (r) => r.phone ?? '—' },
          { key: 'role', header: 'Role', render: (r) => <Badge label={r.role} color="neutral" /> },
          { key: 'primary', header: 'Primary', render: (r) => (r.isPrimary ? 'Yes' : '') },
        ]}
      />

      <Modal
        open={adding}
        title="Add Contact"
        onClose={() => setAdding(false)}
        footer={
          <ModalFooter
            onCancel={() => setAdding(false)}
            onConfirm={handleSubmit(onSubmit)}
            confirmLabel="Add Contact"
            loading={formState.isSubmitting}
          />
        }
      >
        <form onSubmit={handleSubmit(onSubmit)}>
          <TextField label="Name" required {...register('name', { required: true })} />
          <TextField label="Email" type="email" {...register('email')} />
          <TextField label="Phone" {...register('phone')} />
          <Select
            label="Role"
            required
            options={ROLE_OPTIONS}
            {...register('role', { required: true })}
          />
          <Toggle label="Primary contact" {...register('isPrimary')} />
        </form>
      </Modal>
    </div>
  );
}
